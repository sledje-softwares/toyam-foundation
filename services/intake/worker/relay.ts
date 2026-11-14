// One polling run of the Gmail → intake relay. Since D33 this is the hourly safety net behind
// push intake (email.ts); it is idempotent, so mail already forwarded is ignored downstream.
// Originally D12. No Cloudflare imports here so it can be
// tested in Node; `index.ts` wires it to cron, KV and `connect()`.
import { type Duplex, ImapClient } from './imap.ts';

export interface RelayEnv {
  GMAIL_USER: string;
  GMAIL_APP_PASSWORD: string;
  INTAKE_URL: string;              // https://<project>.supabase.co/functions/v1/intake
  INTAKE_SECRET: string;
  MAILBOX?: string;                // default INBOX
  MAX_PER_RUN?: string;            // default 10
  BACKFILL_SINCE?: string;         // optional first-run start, IMAP date e.g. 01-Nov-2026
  ONLY_FROM?: string;              // comma-separated sender domains / addresses (IMAP-side filter)
}

/** IMAP search terms for ONLY_FROM: FROM a | OR FROM a FROM b | OR FROM a OR FROM b FROM c ... */
export function fromCriteria(onlyFrom: string | undefined): string {
  const terms = (onlyFrom ?? '').split(',').map((s) => s.trim().replace(/["\\]/g, '')).filter((s) => s !== '')
    .map((s) => `FROM "${s}"`);
  const or = (t: string[]): string => (t.length === 1 ? t[0] : `OR ${t[0]} ${or(t.slice(1))}`);
  return terms.length ? or(terms) : '';
}

export interface StateStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface RelayState { uidValidity: number; lastUid: number }

export interface RunResult {
  relayed: number[];
  failedUid: number | null;
  state: RelayState;
  note?: string;
}

const STATE_KEY = 'gmail-relay-state';

export async function pollOnce(
  env: RelayEnv,
  open: () => Promise<Duplex> | Duplex,
  store: StateStore,
  post: typeof fetch = fetch,
): Promise<RunResult> {
  const client = new ImapClient(await open());
  try {
    await client.greeting();
    await client.login(env.GMAIL_USER, env.GMAIL_APP_PASSWORD);
    const box = await client.select(env.MAILBOX ?? 'INBOX');

    const saved = await store.get(STATE_KEY);
    let state: RelayState | null = saved ? JSON.parse(saved) : null;
    let note: string | undefined;
    let candidates: number[];
    const filter = fromCriteria(env.ONLY_FROM);
    const withFilter = (c: string) => (filter ? `${c} ${filter}` : c);

    if (!state || state.uidValidity !== box.uidValidity) {
      // First run, or the mailbox was rebuilt: start from now (or from BACKFILL_SINCE).
      note = state ? 'UIDVALIDITY changed: restarted' : 'first run';
      if (env.BACKFILL_SINCE) {
        candidates = await client.uidSearch(withFilter(`SINCE ${env.BACKFILL_SINCE}`));
        state = { uidValidity: box.uidValidity, lastUid: 0 };
      } else {
        state = { uidValidity: box.uidValidity, lastUid: Math.max(box.uidNext - 1, 0) };
        await store.put(STATE_KEY, JSON.stringify(state));
        return { relayed: [], failedUid: null, state, note };
      }
    } else {
      // "n:*" always returns the highest UID, even when it is below n
      candidates = (await client.uidSearch(withFilter(`UID ${state.lastUid + 1}:*`))).filter((u) => u > state!.lastUid);
    }

    const max = parseInt(env.MAX_PER_RUN ?? '10', 10) || 10;
    const relayed: number[] = [];
    let failedUid: number | null = null;
    for (const uid of candidates.slice(0, max)) {
      const msg = await client.fetchMessage(uid);
      if (msg) {
        const headers: Record<string, string> = {
          'content-type': 'message/rfc822',
          'x-intake-secret': env.INTAKE_SECRET,
        };
        if (msg.gmailThreadId) headers['x-gmail-thread-id'] = msg.gmailThreadId;
        if (msg.gmailMessageId) headers['x-gmail-msgid'] = msg.gmailMessageId;
        let ok = false;
        try {
          const res = await post(env.INTAKE_URL, { method: 'POST', headers, body: msg.raw as unknown as BodyInit });
          ok = res.ok;
        } catch { ok = false; }
        if (!ok) { failedUid = uid; break; }          // keep order: retry from here next run
        relayed.push(uid);
      }
      state = { ...state, lastUid: uid };
      await store.put(STATE_KEY, JSON.stringify(state));
    }
    return { relayed, failedUid, state, note };
  } finally {
    await client.logout();
  }
}
