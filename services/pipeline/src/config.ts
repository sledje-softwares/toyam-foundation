// Environment -> configuration. Pure (takes the env as a map) so it can be tested. Secrets are never logged:
// `describeConfig()` reports only which ones are set.
import { hostname } from 'node:os';
import { API_KEY_ENV, PROVIDERS, parseModelRef } from '../../labeller/src/providers.ts';
import type { ModelRef, Provider } from '../../labeller/src/providers.ts';
import type { R2Config } from '../../../supabase/functions/_shared/r2/presign.ts';
import type { Stage } from './types.ts';
import { STAGES } from './types.ts';

export type LabelMode = 'api' | 'manual' | 'off';

export interface Config {
  supabaseUrl: string;
  serviceRoleKey: string;
  workerId: string;
  stages: Stage[];
  concurrency: number;
  pollMs: number;
  maxIdleMs: number;
  staleMinutes: number;
  shutdownGraceMs: number;
  healthPort: number;                  // 0 = no health server
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  r2: R2Config | null;
  maxOriginalBytes: number;
  label: {
    mode: LabelMode;
    offReason: string | null;
    primary: ModelRef | null;
    escalation: ModelRef | null;
    apiKeys: Partial<Record<Provider, string>>;
    threshold: number;
    effort: 'low' | 'medium' | 'high' | null;
    manualDir: string | null;
    manualName: string;
    manualTimeoutMs: number;
    pdfTextChars: number;
    ocrExcerptChars: number;
    commentChars: number;
  };
  ocr: {
    engine: 'none' | 'http';
    url: string | null;
    token: string | null;
    timeoutMs: number;
    deviceMinConfidence: number;
    maxPages: number;
  };
  pdfMaxPages: number;
  fieldMatchMinScore: number;
}

export const DEFAULT_MODELS: Partial<Record<Provider, { primary: string; escalation: string | null }>> = {
  // D37: Haiku 5.5 labels every file; low confidence goes to Sonnet 5.5 at once (standard API, no Batch API)
  anthropic: { primary: 'claude-haiku-5-5', escalation: 'claude-sonnet-5-5' },
};

function num(env: Record<string, string | undefined>, k: string, def: number, min: number, max: number, errors: string[]): number {
  const raw = env[k];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors.push(`${k} must be a number between ${min} and ${max} (got "${raw}")`);
    return def;
  }
  return n;
}

/** "claude-sonnet-5-5" (same provider as the primary) or "provider:model-id". */
function modelSpec(spec: string, provider: Provider, localBase: string | undefined): ModelRef {
  const i = spec.indexOf(':');
  if (i > 0 && PROVIDERS.includes(spec.slice(0, i) as Provider)) return parseModelRef(spec, localBase);
  return parseModelRef(`${provider}:${spec}`, localBase);
}

export function loadConfig(env: Record<string, string | undefined>): { config: Config; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const supabaseUrl = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl) errors.push('SUPABASE_URL is required');
  if (!serviceRoleKey) errors.push('SUPABASE_SERVICE_ROLE_KEY is required');

  const stages = (env.PIPELINE_STAGES ?? STAGES.join(',')).split(',').map((s) => s.trim()).filter(Boolean) as Stage[];
  for (const s of stages) if (!STAGES.includes(s)) errors.push(`PIPELINE_STAGES: unknown stage "${s}"`);

  // ---- labelling ------------------------------------------------------------------------------------
  const localBase = env.LOCAL_VLM_BASE_URL;
  const providerRaw = (env.LABEL_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'off')).trim();
  let mode: LabelMode = 'off';
  let offReason: string | null = null;
  let primary: ModelRef | null = null;
  let escalation: ModelRef | null = null;
  const apiKeys: Partial<Record<Provider, string>> = {};
  for (const p of PROVIDERS) if (env[API_KEY_ENV[p]]) apiKeys[p] = env[API_KEY_ENV[p]] as string;

  if (providerRaw === 'off') {
    offReason = env.LABEL_PROVIDER === 'off' ? 'LABEL_PROVIDER=off' : 'no ANTHROPIC_API_KEY and no LABEL_PROVIDER';
  } else if (providerRaw === 'manual') {
    mode = 'manual';
    if (!env.LABEL_MANUAL_DIR) {
      errors.push('LABEL_PROVIDER=manual needs LABEL_MANUAL_DIR (a folder outside the repository)');
      mode = 'off';
      offReason = 'manual without LABEL_MANUAL_DIR';
    }
  } else if (PROVIDERS.includes(providerRaw as Provider)) {
    const provider = providerRaw as Provider;
    const defaults = DEFAULT_MODELS[provider];
    const primaryId = env.LABEL_MODEL || defaults?.primary;
    if (!primaryId) {
      errors.push(`LABEL_MODEL is required for provider ${provider}`);
    } else {
      try {
        primary = modelSpec(primaryId, provider, localBase);
        const escId = env.LABEL_ESCALATION_MODEL ?? defaults?.escalation ?? null;
        if (escId && escId !== 'off' && escId !== 'none') escalation = modelSpec(escId, provider, localBase);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    const missing = [primary, escalation].filter((r): r is ModelRef => !!r && r.provider !== 'local' && !apiKeys[r.provider]);
    if (missing.length) {
      // refuse to label rather than skip: jobs stay queued until a key is configured
      offReason = `${[...new Set(missing.map((r) => API_KEY_ENV[r.provider]))].join(', ')} not set`;
      warnings.push(`labelling is off: ${offReason}`);
    } else if (primary) {
      mode = 'api';
    }
  } else {
    errors.push(`LABEL_PROVIDER must be one of ${[...PROVIDERS, 'manual', 'off'].join(', ')} (got "${providerRaw}")`);
  }
  if (mode === 'off' && !offReason) offReason = 'configuration error';
  const effortRaw = env.LABEL_EFFORT ?? 'default';
  const effort = effortRaw === 'default' || effortRaw === '' ? null : (['low', 'medium', 'high'].includes(effortRaw) ? effortRaw as 'low' | 'medium' | 'high' : null);
  if (effortRaw && effortRaw !== 'default' && !effort) errors.push(`LABEL_EFFORT must be low, medium, high or default (got "${effortRaw}")`);

  // ---- OCR ------------------------------------------------------------------------------------------
  const ocrEngine = (env.OCR_ENGINE ?? 'none').trim();
  if (ocrEngine !== 'none' && ocrEngine !== 'http') errors.push(`OCR_ENGINE must be none or http (got "${ocrEngine}")`);
  if (ocrEngine === 'http' && !env.OCR_URL) errors.push('OCR_ENGINE=http needs OCR_URL (e.g. http://localhost:8866)');

  // ---- storage --------------------------------------------------------------------------------------
  const r2 = env.R2_ACCOUNT_ID && env.R2_BUCKET && env.R2_READ_ACCESS_KEY_ID && env.R2_READ_SECRET_ACCESS_KEY
    ? { accountId: env.R2_ACCOUNT_ID, bucket: env.R2_BUCKET, accessKeyId: env.R2_READ_ACCESS_KEY_ID, secretAccessKey: env.R2_READ_SECRET_ACCESS_KEY }
    : null;
  if (!r2) warnings.push('R2 read credentials not set: field files (storage_backend r2) cannot be read');

  const config: Config = {
    supabaseUrl,
    serviceRoleKey,
    workerId: (env.WORKER_ID || `pipeline-${hostname()}`).slice(0, 60),
    stages,
    concurrency: num(env, 'PIPELINE_CONCURRENCY', mode === 'manual' ? 8 : 4, 1, 64, errors),
    pollMs: num(env, 'POLL_MS', 1000, 100, 60_000, errors),
    maxIdleMs: num(env, 'POLL_MAX_MS', 15_000, 500, 600_000, errors),
    staleMinutes: num(env, 'STALE_MINUTES', 30, 1, 24 * 60, errors),
    shutdownGraceMs: num(env, 'SHUTDOWN_GRACE_MS', 20_000, 0, 600_000, errors),
    healthPort: num(env, 'HEALTH_PORT', 8080, 0, 65535, errors),
    logLevel: (['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL ?? '') ? env.LOG_LEVEL : 'info') as Config['logLevel'],
    r2,
    maxOriginalBytes: num(env, 'MAX_FILE_MB', 50, 1, 500, errors) * 1024 * 1024,
    label: {
      mode,
      offReason: mode === 'off' ? offReason : null,
      primary,
      escalation,
      apiKeys,
      threshold: num(env, 'LABEL_ESCALATION_THRESHOLD', 0.6, 0, 1, errors),   // 0.6 from the 2026-11-26 Haiku test; set from the bake-off (Q20)
      effort,
      manualDir: env.LABEL_MANUAL_DIR ?? null,
      manualName: (env.LABEL_MANUAL_NAME || 'human').replace(/[^a-z0-9_.-]/gi, '').slice(0, 30) || 'human',
      manualTimeoutMs: num(env, 'LABEL_MANUAL_TIMEOUT_S', 1800, 5, 86_400, errors) * 1000,
      pdfTextChars: num(env, 'LABEL_PDF_TEXT_CHARS', 4000, 200, 50_000, errors),
      ocrExcerptChars: num(env, 'LABEL_OCR_EXCERPT_CHARS', 600, 0, 5000, errors),
      commentChars: num(env, 'LABEL_COMMENT_CHARS', 1500, 0, 5000, errors),
    },
    ocr: {
      engine: ocrEngine === 'http' ? 'http' : 'none',
      url: env.OCR_URL ?? null,
      token: env.OCR_TOKEN ?? null,
      timeoutMs: num(env, 'OCR_TIMEOUT_S', 120, 5, 3600, errors) * 1000,
      deviceMinConfidence: num(env, 'OCR_DEVICE_MIN_CONFIDENCE', 0.5, 0, 1, errors),
      maxPages: num(env, 'OCR_MAX_PAGES', 10, 1, 200, errors),
    },
    pdfMaxPages: num(env, 'PDF_MAX_PAGES', 30, 1, 500, errors),
    fieldMatchMinScore: num(env, 'FIELD_MATCH_MIN_SCORE', 0.3, 0, 1, errors),
  };
  return { config, errors, warnings };
}

/** Safe summary for the start-up log: no secrets, only whether they are set. */
export function describeConfig(c: Config): Record<string, string | number | boolean | null | string[]> {
  return {
    worker_id: c.workerId,
    stages: c.stages,
    concurrency: c.concurrency,
    label_mode: c.label.mode,
    label_off_reason: c.label.offReason,
    label_model: c.label.primary ? `${c.label.primary.provider}/${c.label.primary.model}` : null,
    escalation_model: c.label.escalation ? `${c.label.escalation.provider}/${c.label.escalation.model}` : null,
    escalation_threshold: c.label.threshold,
    label_effort: c.label.effort,
    ocr_engine: c.ocr.engine,
    r2_configured: c.r2 !== null,
    health_port: c.healthPort,
  };
}
