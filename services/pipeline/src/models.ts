// Label models behind one interface: a provider API (services/labeller/src/providers.ts, retries on 429 / 5xx)
// or the `manual` stand-in, where a person or an agent answers from a folder (no API key, Q21 not approved).
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callModel, modelKey } from '../../labeller/src/providers.ts';
import type { FetchLike, ImageInput, ModelRef, RequestExtras, Usage } from '../../labeller/src/providers.ts';

export interface LabelRequest {
  /** Stable per evidence + pipeline version + role; names the manual request files. */
  requestId: string;
  system: string;
  instruction: string;
  image: ImageInput | null;
  /** For the manual stand-in only: what a human needs to answer (no personal data beyond the image / text). */
  meta: { evidence_id: string; template_id: string | null; pipeline_version: string; categories: string[]; fields: string[] };
  signal?: AbortSignal;
}

export interface LabelReply {
  text: string;
  usage: Usage | null;
  /** provider/model-id that answered (the manual stand-in may name the model it used). */
  model: string;
  latencyMs: number;
}

export interface LabelModel {
  key: string;                         // provider/model-id
  label(req: LabelRequest): Promise<LabelReply>;
}

export function createApiModel(ref: ModelRef, apiKey: string, opts: {
  fetch?: FetchLike;
  extras?: RequestExtras;
  maxOutputTokens?: number;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
} = {}): LabelModel {
  const key = modelKey(ref);
  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? (() => Date.now());
  return {
    key,
    async label(req) {
      const t0 = now();
      const signalled: FetchLike = (url, init) => fetchFn(url, { ...init, ...(req.signal ? { signal: req.signal } : {}) } as typeof init);
      const reply = await callModel(signalled, ref, apiKey, req.system, req.instruction, req.image, {
        maxOutputTokens: opts.maxOutputTokens, extras: opts.extras, sleep: opts.sleep,
      });
      return { text: reply.text, usage: reply.usage, model: key, latencyMs: now() - t0 };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Manual stand-in
// ---------------------------------------------------------------------------------------------
//
// <dir>/prompts/<sha12>.txt          system prompt (one per template version; same text the model gets)
// <dir>/requests/<id>.json           what to answer: evidence id, template, allowed codes / field keys,
//                                    instruction, prompt file, image file
// <dir>/requests/<id>.jpg | .txt     the ~384 px image the model would see, or the PDF text
// <dir>/answers/<id>.json            THE ANSWER (written by the person / agent): the model's JSON answer,
//                                    optionally with "model": "provider/model-id" naming who answered
// <dir>/answers.json                 alternative: one object { "<id>": <answer>, ... }
// <dir>/done/                        request + answer files move here once the answer is recorded

export class ManualTimeout extends Error {}
export class Aborted extends Error {}

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** The folder holds case images (personal data): never inside the repository. */
export function assertOutsideRepo(dir: string): void {
  const rel = relative(REPO_ROOT, resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`LABEL_MANUAL_DIR must be outside the repository (it holds case images): ${resolve(dir)}`);
  }
}

const MODEL_NAME = /^[a-z0-9_.-]{1,30}\/[A-Za-z0-9_.:/-]{1,69}$/;

export function createManualModel(opts: {
  dir: string;
  name?: string;                       // recorded as manual/<name> unless the answer names its model
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): LabelModel {
  const dir = resolve(opts.dir);
  assertOutsideRepo(dir);
  const key = `manual/${opts.name ?? 'human'}`;
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  let ready: Promise<void> | null = null;
  const init = () => (ready ??= Promise.all(['prompts', 'requests', 'answers', 'done'].map((d) => mkdir(join(dir, d), { recursive: true }))).then(() => {}));

  return {
    key,
    async label(req) {
      await init();
      const t0 = now();
      const id = safeId(req.requestId);
      const promptName = `${createHash('sha256').update(req.system).digest('hex').slice(0, 12)}.txt`;
      await writeFile(join(dir, 'prompts', promptName), req.system, { flag: 'w' });
      const attachment = req.image ? `${id}.jpg` : `${id}.txt`;
      if (req.image) await writeFile(join(dir, 'requests', attachment), Buffer.from(req.image.base64, 'base64'));
      else await writeFile(join(dir, 'requests', attachment), req.instruction);
      await writeFile(join(dir, 'requests', `${id}.json`), JSON.stringify({
        request_id: id,
        ...req.meta,
        prompt_file: `prompts/${promptName}`,
        attachment: `requests/${attachment}`,
        instruction: req.instruction,
        answer_file: `answers/${id}.json`,
        answer_format: 'the JSON object the system prompt asks for; optional "model": "provider/model-id"',
      }, null, 2));

      for (;;) {
        if (req.signal?.aborted) throw new Aborted('aborted while waiting for a manual answer');
        const answer = await readAnswer(dir, id);
        if (answer !== null) {
          const model = typeof answer.model === 'string' && MODEL_NAME.test(answer.model) ? answer.model : key;
          await archive(dir, id, attachment);
          return { text: JSON.stringify(answer), usage: null, model, latencyMs: now() - t0 };
        }
        if (now() - t0 >= timeoutMs) throw new ManualTimeout(`no manual answer for ${id} within ${Math.round(timeoutMs / 1000)} s`);
        await sleep(pollMs, req.signal);
      }
    },
  };
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.+-]/g, '_').slice(0, 120);
}

async function readAnswer(dir: string, id: string): Promise<Record<string, unknown> | null> {
  const own = await readJson(join(dir, 'answers', `${id}.json`));
  if (own && typeof own === 'object' && !Array.isArray(own)) return own as Record<string, unknown>;
  const all = await readJson(join(dir, 'answers.json'));
  const one = all && typeof all === 'object' ? (all as Record<string, unknown>)[id] : undefined;
  return one && typeof one === 'object' && !Array.isArray(one) ? one as Record<string, unknown> : null;
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;                       // half-written file: try again on the next poll
  }
}

async function archive(dir: string, id: string, attachment: string): Promise<void> {
  const stamp = Date.now();
  for (const [from, to] of [
    [join(dir, 'requests', `${id}.json`), join(dir, 'done', `${id}.${stamp}.request.json`)],
    [join(dir, 'requests', attachment), join(dir, 'done', `${id}.${stamp}.${attachment.endsWith('.jpg') ? 'jpg' : 'txt'}`)],
    [join(dir, 'answers', `${id}.json`), join(dir, 'done', `${id}.${stamp}.answer.json`)],
  ]) {
    await rename(from, to).catch(() => rm(from, { force: true }).catch(() => {}));
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      res();
    }, { once: true });
  });
}
