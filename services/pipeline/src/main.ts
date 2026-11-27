// Entry point: `node src/main.ts` (Node >= 22.18, type stripping). One always-on container (D38).
import { createClient } from '@supabase/supabase-js';
import { loadConfig, describeConfig } from './config.ts';
import { createLogger, errorText } from './log.ts';
import { createSupabaseDb } from './db.ts';
import { createObjectStore } from './storage.ts';
import { createPdfTools, createSharpResizer } from './media.ts';
import { createApiModel, createManualModel } from './models.ts';
import type { LabelModel } from './models.ts';
import { TemplateCache } from './template-context.ts';
import { createHttpEngine, createNoneEngine } from './ocr-engine.ts';
import { createLabelStage } from './stages/label.ts';
import { createTextExtractStage } from './stages/text-extract.ts';
import { createOcrStage } from './stages/ocr.ts';
import { createFieldSuggestStage } from './stages/field-suggest.ts';
import { Worker } from './worker.ts';
import type { Handler } from './worker.ts';
import { healthStatus, startHealthServer } from './health.ts';
import type { Stage } from './types.ts';

const { config, errors, warnings } = loadConfig(process.env);
const log = createLogger({ level: config.logLevel });
for (const w of warnings) log.log('warn', 'config_warning', { message: w });
if (errors.length) {
  for (const e of errors) log.log('error', 'config_error', { message: e });
  process.exit(2);
}

const sb = createClient(config.supabaseUrl, config.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { 'x-client-info': 'toyam-pipeline' } },
});
const db = createSupabaseDb(sb);
const store = createObjectStore({ r2: config.r2, supabase: sb });
const pdf = createPdfTools();
const templates = new TemplateCache(db);

function apiModel(ref: NonNullable<typeof config.label.primary>): LabelModel {
  return createApiModel(ref, config.label.apiKeys[ref.provider] ?? '', { extras: config.label.effort ? { effort: config.label.effort } : {} });
}

const handlers: Partial<Record<Stage, Handler>> = {
  text_extract: createTextExtractStage({ db, store, pdf, log, maxBytes: config.maxOriginalBytes, maxPages: config.pdfMaxPages }),
  ocr: createOcrStage({
    db, store, log,
    engine: config.ocr.engine === 'http' && config.ocr.url
      ? createHttpEngine({ url: config.ocr.url, token: config.ocr.token ?? undefined, timeoutMs: config.ocr.timeoutMs })
      : createNoneEngine(),
    maxBytes: config.maxOriginalBytes, maxPages: config.ocr.maxPages, deviceMinConfidence: config.ocr.deviceMinConfidence,
  }),
  field_suggest: createFieldSuggestStage({ db, templates, log, minMatchScore: config.fieldMatchMinScore }),
};

if (config.label.mode !== 'off') {
  const primary = config.label.mode === 'manual'
    ? createManualModel({ dir: config.label.manualDir as string, name: config.label.manualName, timeoutMs: config.label.manualTimeoutMs })
    : apiModel(config.label.primary as NonNullable<typeof config.label.primary>);
  const escalation = config.label.mode === 'api' && config.label.escalation ? apiModel(config.label.escalation) : null;
  handlers.label = createLabelStage({
    db, store, templates, resizer: createSharpResizer(), pdf, log, primary, escalation,
    threshold: config.label.threshold, maxOriginalBytes: config.maxOriginalBytes, pdfTextChars: config.label.pdfTextChars,
    ocrExcerptChars: config.label.ocrExcerptChars,
  });
} else {
  // label jobs stay queued (and the later stages of those files wait behind them)
  log.log('warn', 'labelling_off', { reason: config.label.offReason });
}

const stages = config.stages.filter((s) => handlers[s]);
const worker = new Worker(db, handlers, log, {
  workerId: config.workerId, stages, concurrency: config.concurrency, pollMs: config.pollMs, maxIdleMs: config.maxIdleMs,
  staleMinutes: config.staleMinutes, shutdownGraceMs: config.shutdownGraceMs,
});

const health = config.healthPort
  ? startHealthServer(config.healthPort, () => healthStatus(worker.stats, { label_mode: config.label.mode, ocr_engine: config.ocr.engine },
      Date.now(), Math.max(60_000, config.maxIdleMs * 3)))
  : null;

log.log('info', 'starting', describeConfig(config));
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.log('info', 'shutdown', { signal });
  await worker.stop();
  health?.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.log('error', 'unhandled_rejection', { error: errorText(err) }));

worker.start().catch((err) => {
  log.log('error', 'worker_crashed', { error: errorText(err) });
  process.exit(1);
});
