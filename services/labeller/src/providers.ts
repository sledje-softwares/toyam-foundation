// Vision model adapters: build the HTTP request and read the answer and token usage.
// Pure functions plus one `callModel` that takes fetch as a parameter, so tests need no network
// and the pipeline worker can reuse them. No npm imports (Node type stripping and Deno).

// openai, openrouter, deepseek and local all speak the OpenAI chat-completions format.
// `local` is a self-hosted OpenAI-compatible server (e.g. vLLM serving Qwen3-VL) at LOCAL_VLM_BASE_URL.
export type Provider = 'anthropic' | 'google' | 'openai' | 'openrouter' | 'deepseek' | 'local';

export const PROVIDERS: Provider[] = ['anthropic', 'google', 'openai', 'openrouter', 'deepseek', 'local'];

export const OPENAI_COMPATIBLE_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com',
};

/** Environment variable holding each provider's API key (local: optional). */
export const API_KEY_ENV: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  local: 'LOCAL_VLM_API_KEY',
};

export interface ModelRef {
  provider: Provider;
  model: string;                 // provider's model id, e.g. claude-haiku-5-5, qwen/qwen3-vl-8b-instruct
  baseUrl?: string;              // OpenAI-compatible providers only; required for local
}

export interface ImageInput {
  base64: string;
  mimeType: string;              // image/jpeg, image/png, image/webp
  longEdge: number;              // pixels after resizing; selects OpenAI's detail level
}

export interface Usage {
  input: number;                 // uncached input tokens
  cachedRead: number;
  cacheWrite: number;
  output: number;                // includes reasoning / thinking tokens where reported
}

export interface ModelReply {
  text: string;
  usage: Usage;
}

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export const MAX_OUTPUT_TOKENS = 1024;   // single image: room for thinking models; a label answer is ~80 tokens

/** "anthropic:claude-haiku-5-5" → { provider, model }. The model id may itself contain ":" or "/". */
export function parseModelRef(spec: string, localBaseUrl?: string): ModelRef {
  const i = spec.indexOf(':');
  const provider = spec.slice(0, i) as Provider;
  const model = spec.slice(i + 1);
  if (i < 1 || !model || !PROVIDERS.includes(provider)) {
    throw new Error(`Model must be written provider:model-id with provider ${PROVIDERS.join(', ')} (got "${spec}")`);
  }
  if (provider === 'local') {
    if (!localBaseUrl) throw new Error('local models need LOCAL_VLM_BASE_URL, e.g. http://localhost:8000/v1');
    return { provider, model, baseUrl: localBaseUrl.replace(/\/+$/, '') };
  }
  return OPENAI_COMPATIBLE_BASE[provider] ? { provider, model, baseUrl: OPENAI_COMPATIBLE_BASE[provider] } : { provider, model };
}

export function modelKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/** Provider-specific request options (ignored by providers that do not support them). */
export interface RequestExtras {
  /** Anthropic `output_config.effort` (thinking depth); omitted = the model's default. */
  effort?: 'low' | 'medium' | 'high';
}

/**
 * `image` may be null for a text-only request (the pipeline labels PDFs with a text layer from their text,
 * which then travels in `instruction`).
 */
export function buildRequest(ref: ModelRef, apiKey: string, system: string, instruction: string, image: ImageInput | null,
                             maxOutputTokens = MAX_OUTPUT_TOKENS, extras: RequestExtras = {}): HttpRequest {
  switch (ref.provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: {
          model: ref.model,
          max_tokens: maxOutputTokens,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          ...(extras.effort ? { output_config: { effort: extras.effort } } : {}),
          messages: [{
            role: 'user',
            content: [
              ...(image ? [{ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } }] : []),
              { type: 'text', text: instruction },
            ],
          }],
        },
      };
    case 'google':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ref.model)}:generateContent`,
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [...(image ? [{ inlineData: { mimeType: image.mimeType, data: image.base64 } }] : []), { text: instruction }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens },
        },
      };
    case 'openai':
    case 'openrouter':
    case 'deepseek':
    case 'local':
      return {
        url: `${ref.baseUrl ?? OPENAI_COMPATIBLE_BASE[ref.provider]}/chat/completions`,
        headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), 'content-type': 'application/json' },
        body: {
          model: ref.model,
          max_completion_tokens: maxOutputTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                ...(image ? [{ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: image.longEdge <= 512 ? 'low' : 'high' } }] : []),
                { type: 'text', text: instruction },
              ],
            },
          ],
        },
      };
  }
}

/** Extract answer text and normalised usage from a provider's JSON response. */
export function readResponse(provider: Provider, json: unknown): ModelReply {
  const r = (json ?? {}) as Record<string, any>;
  switch (provider) {
    case 'anthropic': {
      const text = (Array.isArray(r.content) ? r.content : [])
        .filter((b: any) => b?.type === 'text').map((b: any) => String(b.text)).join('');
      const u = r.usage ?? {};
      return { text, usage: { input: n(u.input_tokens), cachedRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), output: n(u.output_tokens) } };
    }
    case 'google': {
      const parts = r.candidates?.[0]?.content?.parts;
      const text = (Array.isArray(parts) ? parts : []).filter((p: any) => !p?.thought && typeof p?.text === 'string').map((p: any) => p.text).join('');
      const u = r.usageMetadata ?? {};
      const cached = n(u.cachedContentTokenCount);
      return { text, usage: { input: n(u.promptTokenCount) - cached, cachedRead: cached, cacheWrite: 0, output: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount) } };
    }
    default: {
      // OpenAI-compatible
      const text = String(r.choices?.[0]?.message?.content ?? '');
      const u = r.usage ?? {};
      const cached = n(u.prompt_tokens_details?.cached_tokens);
      // DeepSeek reports cache hits as prompt_cache_hit_tokens
      const hit = cached || n(u.prompt_cache_hit_tokens);
      return { text, usage: { input: n(u.prompt_tokens) - hit, cachedRead: hit, cacheWrite: 0, output: n(u.completion_tokens) } };
    }
  }
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export class HttpError extends Error {
  status: number;
  retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface CallOptions {
  attempts?: number;             // default 4
  maxOutputTokens?: number;      // default MAX_OUTPUT_TOKENS; a collage needs more
  extras?: RequestExtras;
  sleep?: (ms: number) => Promise<unknown>;
}

/** One call with retries on rate limits and server errors (exponential back-off). */
export async function callModel(fetchFn: FetchLike, ref: ModelRef, apiKey: string, system: string, instruction: string,
                                image: ImageInput | null, opts: CallOptions = {}): Promise<ModelReply> {
  const attempts = opts.attempts ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const req = buildRequest(ref, apiKey, system, instruction, image, opts.maxOutputTokens, opts.extras);
  for (let attempt = 1; ; attempt++) {
    const res = await fetchFn(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    if (res.ok) return readResponse(ref.provider, await res.json());
    const err = new HttpError(res.status, `${modelKey(ref)}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    if (!err.retryable || attempt >= attempts) throw err;
    await sleep(1000 * 2 ** (attempt - 1));
  }
}
