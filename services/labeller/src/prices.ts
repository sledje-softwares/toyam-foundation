// List prices in USD per million tokens, as researched on 2026-11-14 (D34). Prices and model ids
// change often: check the provider's pricing page before a bake-off and override with --prices.
import type { Usage } from './providers.ts';

export interface Price {
  input: number;
  output: number;
  cachedRead?: number;   // default: input × 0.1
  cacheWrite?: number;   // default: input × 1.25
}

export const DEFAULT_PRICES: Record<string, Price> = {
  // Prompts up to 100k tokens (a label request is ~1–3k).
  'anthropic/claude-haiku-5-5': { input: 0.10, output: 0.50, cachedRead: 0.01, cacheWrite: 0.125 },
  'anthropic/claude-sonnet-5-5': { input: 2.00, output: 10.00, cachedRead: 0.20, cacheWrite: 2.50 },
  'google/gemini-2.5-flash-lite': { input: 0.10, output: 0.40, cachedRead: 0.025 },
  'google/gemini-3.1-flash-lite': { input: 0.25, output: 1.50, cachedRead: 0.025 },
  'openai/gpt-5.4-nano': { input: 0.20, output: 1.25, cachedRead: 0.02 },
  'openai/gpt-5-nano': { input: 0.05, output: 0.40, cachedRead: 0.005 },
  // Open-weight Qwen3-VL through a hosting provider (OpenRouter routes to the cheapest host).
  'openrouter/qwen/qwen3-vl-8b-instruct': { input: 0.12, output: 0.46 },
  // DeepSeek has peak / off-peak rates; this is the catalogue figure. Test images only (data is stored in China).
  'deepseek/deepseek-flash': { input: 0.22, output: 0.66, cachedRead: 0.014 },
  // local (self-hosted): no token price — the cost is GPU time; the summary reports latency instead.
};

/** Cost in USD of one call, or null when the model has no price. */
export function costOf(key: string, usage: Usage, prices: Record<string, Price> = DEFAULT_PRICES): number | null {
  const p = findPrice(key, prices);
  if (!p) return null;
  const cachedRead = p.cachedRead ?? p.input * 0.1;
  const cacheWrite = p.cacheWrite ?? p.input * 1.25;
  return (usage.input * p.input + usage.cachedRead * cachedRead + usage.cacheWrite * cacheWrite + usage.output * p.output) / 1e6;
}

/** Exact key, else the longest key that prefixes it (dated or preview model ids). */
export function findPrice(key: string, prices: Record<string, Price>): Price | undefined {
  if (prices[key]) return prices[key];
  const match = Object.keys(prices).filter((k) => key.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return match ? prices[match] : undefined;
}
