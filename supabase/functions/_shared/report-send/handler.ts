// Request flow of the `report-send` function (8.2, D50) against an injected gateway and mailer, so the
// whole flow is tested from Node with fakes. The Deno entry point (../../report-send/index.ts) wires the
// gateway to supabase-js (the caller's JWT for the visibility check, the service-role key for the
// sender's own functions) and the mailer to Deno.connectTls(smtp.gmail.com:465).
//
// No-duplicate rules (D50): the database fixes the Message-ID at the first claim and leases one sender at
// a time; this layer never sends a claimed row twice and never retries by itself:
//   nothing handed to SMTP (file / config / connect / refusal before DATA or a 5xx after it) → failed
//   body handed over but the final answer lost                                              → unknown
//   accepted                                                                                → complete
//   accepted but the database could not record it                                          → left "sending";
//        claim_report_send turns it into unknown after the lease, and a person checks the Sent folder.
import { buildMime, newMessageId } from '../send/mime.ts';
import { MB, planDelivery } from '../send/plan.ts';
import { type Duplex, sendSmtp, SmtpUncertain } from '../send/smtp.ts';
import {
  attachmentFor, bearerToken, buildEnvelope, checkFile, type ClaimedSend, type ConfigResult, dbErrorText, fail, type Failure,
  isClaimedSend, messageIdDomain, parseRequest, type ReportFileRow, secretMatches, type SendConfig,
} from './logic.ts';

export const MAX_BODY_CHARS = 10_000;
export const SMTP_TIMEOUT_MS = 60_000;

type DbError = { code?: string; message?: string } | null;

export interface Gateway {
  /**
   * With the caller's JWT: the send as the caller sees it under RLS (staff on a case they manage).
   * null = not visible; 'unauthorized' = no valid session; 'error' = could not check.
   */
  visibleSend(jwt: string, id: string): Promise<{ status: string } | null | 'unauthorized' | 'error'>;
  /** With the caller's JWT: public.is_staff(). */
  isStaff(jwt: string): Promise<boolean | 'unauthorized' | 'error'>;
  // ---- service role (server-side only) ----
  /** Queued sends (oldest first) and sends still marked sending, with their claim time. */
  pendingSends(limit: number): Promise<{ id: string; status: string; claimed_at: string | null }[] | null>;
  setting(key: string): Promise<string | null>;
  claim(id: string, messageId: string, testRecipient: string | null): Promise<{ data: unknown; error: DbError }>;
  reportFiles(reportId: string): Promise<ReportFileRow[] | null>;
  /** Object bytes from the `reports` bucket; null when missing or larger than maxBytes. */
  download(path: string, maxBytes: number): Promise<Uint8Array | null>;
  complete(id: string, delivery: 'attached' | 'link'): Promise<{ error: DbError }>;
  fail(id: string, error: string, ambiguous: boolean): Promise<{ error: DbError }>;
  /** Log without secrets or mail content (ids, codes, outcomes). */
  log(msg: string): void;
}

export interface Mailer {
  /** Implicit-TLS connection to the SMTP server. */
  open(): Promise<Duplex>;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export type Outcome = 'skipped' | 'sent' | 'test_sent' | 'failed' | 'unknown' | 'error';

export interface Deps {
  gw: Gateway;
  mailer: Mailer;
  now?: () => Date;
  newId?: () => string;
}

const ok = (status: number, data: Record<string, unknown>): Reply => ({ status, body: { ok: true, ...data } });
const err = (f: Failure): Reply => ({ status: f.status, body: { ok: false, error: f.error } });
const NOT_CONFIGURED = fail(503, 'not_configured', 'Sending is not set up yet (ask the admin).');

function firstRow(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

/** Marks a claimed send failed (nothing left the building). */
async function failClean(gw: Gateway, id: string, reason: string): Promise<Outcome> {
  const r = await gw.fail(id, reason, false);
  if (r.error) gw.log(`send ${id}: fail_report_send failed (${dbErrorText(r.error)}); the lease will mark it unknown`);
  else gw.log(`send ${id}: failed before sending`);
  return 'failed';
}

/** Claims one send and delivers it. Never throws. */
export async function processSend(id: string, cfg: SendConfig, deps: Deps): Promise<Outcome> {
  const { gw, mailer } = deps;
  const now = deps.now ?? (() => new Date());
  let claimed: ClaimedSend;
  try {
    const messageId = newMessageId(messageIdDomain(cfg.smtpUser), deps.newId?.());
    const c = await gw.claim(id, messageId, cfg.mode === 'test' ? cfg.testTo : null);
    if (c.error) {
      gw.log(`send ${id}: claim failed (${dbErrorText(c.error)})`);
      return 'error';
    }
    const row = firstRow(c.data);
    if (row === undefined || row === null) return 'skipped';
    if (!isClaimedSend(row)) {
      gw.log(`send ${id}: unexpected claim row`);
      return 'error';
    }
    claimed = row;
  } catch (e) {
    gw.log(`send ${id}: claim threw ${(e as Error).name}`);
    return 'error';
  }

  // Everything up to the SMTP handover: a problem here means nothing was sent.
  let raw: string;
  let rcpt: string[];
  try {
    const maxMb = Number(await gw.setting('send_attach_max_mb') ?? '18');
    const maxBytes = (Number.isFinite(maxMb) && maxMb > 0 ? maxMb : 18) * MB;
    const files = await gw.reportFiles(claimed.report_id);
    if (!files) return failClean(gw, id, 'The report files could not be listed. Try again');
    const attachments = [];
    let total = 0;
    for (const format of claimed.formats) {
      const row = files.find((f) => f.format === format);
      if (!row) return failClean(gw, id, `The ${format.toUpperCase()} file of this report version has not been generated`);
      if (row.size_bytes !== null && row.size_bytes > maxBytes) {
        return failClean(gw, id, tooBig(row.size_bytes, maxBytes));
      }
      const data = await gw.download(row.storage_path, maxBytes + 1);
      const problem = await checkFile(row, data);
      if (problem) return failClean(gw, id, problem);
      total += data!.length;
      attachments.push(attachmentFor(claimed.attachment_name, format, data!));
    }
    // 8.3 secure links are not built yet: no annexure pack, and a report over the limit is not sent.
    const plan = planDelivery({ reportBytes: attachments.map((a) => a.data.length), annexZipBytes: 0, attachMaxBytes: maxBytes });
    if (plan.kind === 'link') return failClean(gw, id, tooBig(total, maxBytes));
    const env = buildEnvelope(cfg, claimed, attachments, now());
    raw = buildMime(env.mail);
    rcpt = env.rcpt;
  } catch (e) {
    return failClean(gw, id, `The email could not be prepared: ${(e as Error).message.slice(0, 200)}`);
  }

  let io: Duplex;
  try {
    io = await mailer.open();
  } catch (e) {
    return failClean(gw, id, `Could not connect to the mail server: ${(e as Error).message.slice(0, 200)}`);
  }
  try {
    await sendSmtp(io, { user: cfg.smtpUser, password: cfg.smtpPassword }, { from: cfg.smtpUser, to: rcpt }, raw,
      { helo: 'toyam-report-send', timeoutMs: SMTP_TIMEOUT_MS });
  } catch (e) {
    const uncertain = e instanceof SmtpUncertain;
    const r = await gw.fail(id, (e as Error).message.slice(0, 400), uncertain);
    if (r.error) gw.log(`send ${id}: fail_report_send failed (${dbErrorText(r.error)}); the lease will mark it unknown`);
    else gw.log(`send ${id}: ${uncertain ? 'outcome unknown' : 'refused by the mail server'}`);
    return uncertain ? 'unknown' : 'failed';
  }

  // Accepted by the server: record it. Repeating complete_report_send is harmless; never send again.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await gw.complete(id, 'attached').catch((e: Error) => ({ error: { code: 'thrown', message: e.name } }));
    if (!r.error) {
      gw.log(`send ${id}: ${cfg.mode === 'test' ? 'test_sent' : 'sent'}`);
      return cfg.mode === 'test' ? 'test_sent' : 'sent';
    }
    gw.log(`send ${id}: complete_report_send attempt ${attempt} failed (${dbErrorText(r.error)})`);
  }
  gw.log(`send ${id}: MAIL ACCEPTED BUT NOT RECORDED; it becomes unknown after the lease and must be settled as sent`);
  return 'unknown';
}

function tooBig(bytes: number, maxBytes: number): string {
  const mb = (n: number) => (n / MB).toFixed(1);
  return `The report files are ${mb(bytes)} MB, more than the ${mb(maxBytes)} MB that can be attached. `
    + 'Sending large reports as a secure link is not available yet; deliver it another way and record it on Submissions';
}

/** Settles stale claims (claim_report_send marks them unknown) and sends up to `batch` queued ones, oldest first. */
export async function sweep(cfg: SendConfig, deps: Deps): Promise<{ id: string; outcome: Outcome }[] | null> {
  const { gw } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const rows = await gw.pendingSends(50);
  if (!rows) return null;
  const lease = Number(await gw.setting('send_lease_minutes') ?? '10');
  const leaseMs = (Number.isFinite(lease) && lease > 0 ? lease : 10) * 60_000;
  const results: { id: string; outcome: Outcome }[] = [];
  for (const r of rows) {
    if (r.status === 'sending' && r.claimed_at && now.getTime() - Date.parse(r.claimed_at) > leaseMs) {
      // nothing is sent here: the claim sees the expired lease and records unknown
      results.push({ id: r.id, outcome: await processSend(r.id, cfg, deps) });
    }
  }
  let sent = 0;
  for (const r of rows) {
    if (r.status !== 'queued' || sent >= cfg.sweepBatch) continue;
    sent++;
    results.push({ id: r.id, outcome: await processSend(r.id, cfg, deps) });
  }
  return results;
}

export interface Incoming {
  method: string;
  authorization: string | null;
  sendSecret: string | null;
  body: string;
}

/**
 * POST { action: 'send', id }   Authorization: Bearer <staff JWT>   → 202, delivery continues in `defer`
 * POST { action: 'sweep' }      x-send-secret: <SEND_SECRET>       → 200 with the outcomes
 * POST { action: 'mode' }       Authorization: Bearer <staff JWT>   → 200 { configured, mode, test_to }
 */
export async function handleReportSend(req: Incoming, config: ConfigResult, deps: Deps,
                                       defer: (p: Promise<unknown>) => void): Promise<Reply> {
  const { gw } = deps;
  if (req.method !== 'POST') return err(fail(405, 'method_not_allowed', 'Use POST.'));
  if (req.body.length > MAX_BODY_CHARS) return err(fail(400, 'invalid_body', 'The request is too large.'));
  let body: unknown;
  try {
    body = JSON.parse(req.body);
  } catch {
    return err(fail(400, 'invalid_body', 'Send a JSON object.'));
  }
  const parsed = parseRequest(body);
  if (!parsed.ok) return err(parsed.failure);
  const r = parsed.value;

  if (r.action === 'sweep') {
    if (!config.ok) {
      gw.log(`not configured: ${config.problem}`);
      return err(NOT_CONFIGURED);
    }
    if (!secretMatches(req.sendSecret ?? '', config.config.sweepSecret)) return err(fail(401, 'unauthorized', 'Not allowed.'));
    const results = await sweep(config.config, deps);
    if (!results) return err(fail(503, 'unavailable', 'The send queue could not be read.'));
    return ok(200, { mode: config.config.mode, results });
  }

  const jwt = bearerToken(req.authorization);
  if (!jwt) return err(fail(401, 'unauthorized', 'Sign in again.'));

  if (r.action === 'mode') {
    const staff = await gw.isStaff(jwt);
    if (staff === 'unauthorized') return err(fail(401, 'unauthorized', 'Sign in again.'));
    if (staff === 'error') return err(fail(503, 'unavailable', 'Try again in a moment.'));
    if (!staff) return err(fail(403, 'forbidden', 'Only office staff can send reports.'));
    if (!config.ok) return ok(200, { configured: false, mode: null, test_to: null });
    return ok(200, { configured: true, mode: config.config.mode, test_to: config.config.testTo });
  }

  // send: the caller must see the row (RLS: staff on a case they manage) and it must still be queued
  const seen = await gw.visibleSend(jwt, r.id);
  if (seen === 'unauthorized') return err(fail(401, 'unauthorized', 'Sign in again.'));
  if (seen === 'error') return err(fail(503, 'unavailable', 'Try again in a moment.'));
  if (!seen) return err(fail(404, 'not_found', 'Send not found.'));
  if (!config.ok) {
    gw.log(`not configured: ${config.problem}`);
    return err(NOT_CONFIGURED);
  }
  if (seen.status !== 'queued') {
    return { status: 409, body: { ok: false, error: { code: 'not_queued', message: 'This send is not waiting to be sent.' }, status: seen.status } };
  }
  const cfg = config.config;
  defer(processSend(r.id, cfg, deps));
  return ok(202, { accepted: true, mode: cfg.mode, test_to: cfg.testTo });
}
