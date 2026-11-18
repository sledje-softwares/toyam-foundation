// Report send sweep (8.2, D50): on the 10-minute cron the Worker asks the Supabase `report-send`
// function to settle expired claims and send anything still queued (the web app normally starts a send
// right after it is queued; this catches what that missed). The Worker holds only the shared SEND_SECRET:
// no service-role key, no SMTP. Off until both REPORT_SEND_URL and SEND_SECRET are set.
// No Cloudflare imports, so it is tested in Node; index.ts wires it.

export interface SendSweepEnv {
  REPORT_SEND_URL?: string;            // https://<ref>.supabase.co/functions/v1/report-send ; empty = off
  SEND_SECRET?: string;                // same value as the report-send function's SEND_SECRET
}

export interface SendSweepResult {
  ran: boolean;
  status?: number;
  mode?: string;
  results?: { id: string; outcome: string }[];
  error?: string;
}

export async function runSendSweep(env: SendSweepEnv, post: typeof fetch = fetch): Promise<SendSweepResult> {
  const url = (env.REPORT_SEND_URL ?? '').trim();
  const secret = env.SEND_SECRET ?? '';
  if (!url || !secret) return { ran: false };
  try {
    const res = await post(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-send-secret': secret },
      body: JSON.stringify({ action: 'sweep' }),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const e = body.error as { code?: string } | undefined;
      return { ran: true, status: res.status, error: e?.code ?? 'error' };
    }
    return {
      ran: true,
      status: res.status,
      mode: typeof body.mode === 'string' ? body.mode : undefined,
      results: Array.isArray(body.results) ? body.results as { id: string; outcome: string }[] : [],
    };
  } catch (e) {
    return { ran: true, error: e instanceof Error ? e.message : String(e) };
  }
}
