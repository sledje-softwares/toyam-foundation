// Structured JSON logs, one object per line on stdout. Callers pass ids, counts, codes and durations only:
// never file names, OCR text, descriptions, model answers or values (personal data, Q18 / rule 7).

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, string | number | boolean | null | undefined | string[] | number[]>;

export interface Logger {
  log(level: Level, event: string, fields?: Fields): void;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(opts: { level?: Level; write?: (line: string) => void; now?: () => Date } = {}): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = opts.now ?? (() => new Date());
  return {
    log(level, event, fields = {}) {
      if (ORDER[level] < min) return;
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;
      write(JSON.stringify({ ts: now().toISOString(), level, event, ...clean }));
    },
  };
}

/** Error text for logs and job rows: first line, capped; secrets in URLs (presigned queries) are cut off. */
export function errorText(err: unknown, max = 300): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split('\n')[0].replace(/https?:\/\/\S+/g, (u) => u.split('?')[0]).slice(0, max);
}

/** A logger that keeps lines in memory (tests). */
export function memoryLogger(): Logger & { lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    log(level, event, fields = {}) {
      lines.push({ level, event, ...fields });
    },
  };
}
