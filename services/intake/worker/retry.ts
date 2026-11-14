// Queued intake retry (D39): the 10-minute cron. Claims queued retries through the intake
// function, posts each email id back to it (the function reprocesses and records the outcome),
// then runs the escalation and mails ONE alert per returned email to the shared inbox.
// The Worker reaches the database only through the intake function and its secret: no
// service-role key here. No Cloudflare imports, so it is tested in Node; index.ts wires it.

export interface RetryEnv {
  INTAKE_URL: string;
  INTAKE_SECRET: string;
  GMAIL_USER: string;                  // the shared mailbox: sender and recipient of alerts
  RETRY_BATCH?: string;                // default 10
  ALERT_EMAIL?: string;                // "smtp" (Gmail SMTP, app password) | "off" (log only); default off
  ALERT_TO?: string;                   // default GMAIL_USER
  APP_URL?: string;                    // optional web origin, e.g. https://app.example.in
}

export interface ClaimedRetry { id: string; raw_storage_path: string | null }

export interface StuckRetry {
  email_id: string;
  from_address: string;
  subject: string | null;
  received_at: string;
  email_status: string;
  retry_attempts: number;
  retry_requested_at: string | null;
}

export interface AlertMail { to: string; subject: string; text: string }

/** How alert emails leave (config flag ALERT_EMAIL). null = sending disabled: alerts are logged. */
export interface AlertSender { send(mail: AlertMail): Promise<void> }

export interface RetryRunResult {
  claimed: number;
  outcomes: { id: string; status: number; result?: string }[];
  claimError?: string;
  alerts: number;
  mailed: number;
  skipped: number;                     // alert emails not sent (sending off or failed); in-app alerts stand
  escalateError?: string;
}

export const ALERT_SUBJECT = '[Toyam alert] Intake retry stuck';

/** Only sender, subject, dates and attempts; never the body or extracted personal data. */
export function alertMail(a: StuckRetry, to: string, appUrl?: string): AlertMail {
  const link = `${(appUrl ?? '').replace(/\/+$/, '')}/intake/failed`;
  const state = a.email_status === 'failed' ? 'failed again after a retry' : 'still waiting for a retry after an hour';
  return {
    to,
    subject: ALERT_SUBJECT,
    text: [
      `An insurer email is ${state}.`,
      '',
      `Sender:   ${a.from_address}`,
      `Subject:  ${a.subject ?? '(no subject)'}`,
      `Received: ${a.received_at}`,
      `Attempts: ${a.retry_attempts}`,
      '',
      `Open ${link} to look at it and retry.`,
    ].join('\n'),
  };
}

function opUrl(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export async function runRetryQueue(env: RetryEnv, sender: AlertSender | null, post: typeof fetch = fetch,
                                     log: (line: string) => void = console.log): Promise<RetryRunResult> {
  const headers = { 'x-intake-secret': env.INTAKE_SECRET };
  const call = async (params: Record<string, string>) => {
    const res = await post(opUrl(env.INTAKE_URL, params), { method: 'POST', headers });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: res.status, ok: res.ok, body };
  };
  const out: RetryRunResult = { claimed: 0, outcomes: [], alerts: 0, mailed: 0, skipped: 0 };

  try {
    const claim = await call({ op: 'claim-retries', limit: String(parseInt(env.RETRY_BATCH ?? '10', 10) || 10) });
    if (!claim.ok) throw new Error(`claim ${claim.status}: ${String(claim.body.error ?? '')}`);
    const items = (claim.body.items ?? []) as ClaimedRetry[];
    out.claimed = items.length;
    for (const item of items) {
      try {
        const r = await call({ retry: item.id });
        out.outcomes.push({ id: item.id, status: r.status, result: r.body.result as string | undefined });
      } catch (e) {
        // the lease expires and the next run claims it again
        out.outcomes.push({ id: item.id, status: 0, result: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    out.claimError = e instanceof Error ? e.message : String(e);
  }

  // escalation runs even when the claim failed: that is exactly when retries get stuck
  try {
    const esc = await call({ op: 'escalate-retries' });
    if (!esc.ok) throw new Error(`escalate ${esc.status}: ${String(esc.body.error ?? '')}`);
    const alerts = (esc.body.alerts ?? []) as StuckRetry[];
    out.alerts = alerts.length;
    for (const a of alerts) {
      const mail = alertMail(a, env.ALERT_TO || env.GMAIL_USER, env.APP_URL);
      if (!sender) {
        out.skipped++;
        log(JSON.stringify({ mode: 'retry-alert', skipped: 'ALERT_EMAIL off', email_id: a.email_id }));
        continue;
      }
      try {
        await sender.send(mail);
        out.mailed++;
      } catch (e) {
        // in-app alerts are already in place; the email is best effort (not resent)
        out.skipped++;
        log(JSON.stringify({ mode: 'retry-alert', failed: e instanceof Error ? e.message : String(e), email_id: a.email_id }));
      }
    }
  } catch (e) {
    out.escalateError = e instanceof Error ? e.message : String(e);
  }
  return out;
}
