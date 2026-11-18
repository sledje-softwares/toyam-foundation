// Pure parts of the `report-send` edge function (8.2, D50): configuration and the test-mode switch,
// request parsing, the outgoing mail (recipients, subject, body, attachments) and error texts.
// No I/O; runs in Deno and in Node's type stripping. Contract: supabase/functions/report-send/README.md.
import { normaliseAddress, contentTypeFor } from '../send/render.ts';
import type { MailAttachment, OutgoingMail } from '../send/mime.ts';

export type SendMode = 'test' | 'live';

export interface SendConfig {
  mode: SendMode;
  /** test mode: the only address any mail goes to. Always null in live mode. */
  testTo: string | null;
  /** Gmail account the mail is sent from (SMTP AUTH user and From address). */
  smtpUser: string;
  smtpPassword: string;
  fromName: string;
  /** Shared secret of the sweep caller (the intake Worker cron). Empty = sweep disabled. */
  sweepSecret: string;
  /** Sends handled per sweep call (keeps one call inside the edge wall-clock limit). */
  sweepBatch: number;
}

export type ConfigResult = { ok: true; config: SendConfig } | { ok: false; problem: string };

export const DEFAULT_FROM_NAME = 'Toyam Investigation and Valuation Pvt. Ltd';

/**
 * Reads the secrets. The sender refuses to start (every request answers `not_configured`, nothing is
 * claimed) when the mode switch is inconsistent:
 *   SEND_MODE absent or "test"  → test mode; SEND_TEST_TO must be one valid address
 *   SEND_MODE "live"            → live mode; SEND_TEST_TO must NOT be set (a leftover test address is a mistake)
 *   anything else               → refused
 */
export function readSendConfig(get: (k: string) => string | undefined): ConfigResult {
  const rawMode = (get('SEND_MODE') ?? '').trim().toLowerCase();
  const rawTestTo = (get('SEND_TEST_TO') ?? '').trim();
  if (rawMode !== '' && rawMode !== 'test' && rawMode !== 'live') {
    return { ok: false, problem: 'SEND_MODE must be "test" or "live"' };
  }
  const mode: SendMode = rawMode === 'live' ? 'live' : 'test';
  let testTo: string | null = null;
  if (mode === 'live') {
    if (rawTestTo !== '') return { ok: false, problem: 'SEND_TEST_TO is set while SEND_MODE=live; remove it to send to insurers' };
  } else {
    if (rawTestTo === '') return { ok: false, problem: 'Test mode needs SEND_TEST_TO (the only address test mail may go to)' };
    testTo = normaliseAddress(rawTestTo);
    if (!testTo) return { ok: false, problem: 'SEND_TEST_TO is not a single valid address' };
  }
  const smtpUser = normaliseAddress(get('SMTP_USER') ?? '');
  // Gmail shows app passwords in groups of four; the spaces are not part of it
  const smtpPassword = (get('SMTP_PASSWORD') ?? '').replace(/\s+/g, '');
  if (!smtpUser || !smtpPassword) return { ok: false, problem: 'SMTP_USER / SMTP_PASSWORD (Gmail address and app password) are not set' };
  const batch = Number(get('SEND_SWEEP_BATCH') ?? '3');
  return {
    ok: true,
    config: {
      mode,
      testTo,
      smtpUser,
      smtpPassword,
      fromName: (get('SEND_FROM_NAME') ?? '').replace(/[\r\n]+/g, ' ').trim() || DEFAULT_FROM_NAME,
      sweepSecret: get('SEND_SECRET') ?? '',
      sweepBatch: Number.isInteger(batch) && batch >= 1 && batch <= 10 ? batch : 3,
    },
  };
}

// ---------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SendRequest =
  | { action: 'send'; id: string }
  | { action: 'sweep' }
  | { action: 'mode' };

export interface Failure {
  status: number;
  error: { code: string; message: string };
}
export const fail = (status: number, code: string, message: string): Failure => ({ status, error: { code, message } });

export function parseRequest(body: unknown): { ok: true; value: SendRequest } | { ok: false; failure: Failure } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, failure: fail(400, 'invalid_body', 'Send a JSON object.') };
  }
  const b = body as Record<string, unknown>;
  switch (b.action) {
    case 'send':
      if (typeof b.id !== 'string' || !UUID.test(b.id)) return { ok: false, failure: fail(400, 'invalid_body', 'id must be a send id.') };
      return { ok: true, value: { action: 'send', id: b.id } };
    case 'sweep':
      return { ok: true, value: { action: 'sweep' } };
    case 'mode':
      return { ok: true, value: { action: 'mode' } };
    default:
      return { ok: false, failure: fail(400, 'invalid_body', 'action must be send, sweep or mode.') };
  }
}

/** Constant-time comparison of the sweep secret (an empty expected secret never matches). */
export function secretMatches(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

export function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------
// The claimed send and its files
// ---------------------------------------------------------------------
/** A row returned by claim_report_send. */
export interface ClaimedSend {
  id: string;
  case_id: string;
  report_id: string;
  formats: string[];
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  body: string;
  attachment_name: string;
  in_reply_to: string | null;
  references_ids: string[] | null;
  message_id: string;
  case_ref: string;
}

export interface ReportFileRow {
  format: string;
  storage_path: string;
  sha256: string | null;
  size_bytes: number | null;
}

export function isClaimedSend(v: unknown): v is ClaimedSend {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.report_id === 'string' && typeof r.message_id === 'string'
    && Array.isArray(r.formats) && Array.isArray(r.to_addresses) && Array.isArray(r.cc_addresses)
    && typeof r.subject === 'string' && typeof r.body === 'string' && typeof r.attachment_name === 'string';
}

/** Lower-case hex SHA-256 of bytes (Web Crypto: Deno and Node). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Checks a downloaded report file against its record. null = good, else the reason (nothing is sent). */
export async function checkFile(row: ReportFileRow, data: Uint8Array | null): Promise<string | null> {
  const what = `The ${row.format.toUpperCase()} file of this report version`;
  if (!row.sha256) return `${what} has no recorded SHA-256; generate the report again`;
  if (!data) return `${what} could not be read from storage`;
  if (row.size_bytes !== null && row.size_bytes !== data.length) return `${what} has a different size than recorded`;
  if ((await sha256Hex(data)) !== row.sha256) return `${what} does not match its recorded SHA-256`;
  return null;
}

export function attachmentFor(name: string, format: string, data: Uint8Array): MailAttachment {
  const f = format === 'docx' ? 'docx' : 'pdf';
  return { filename: `${name}.${f}`, contentType: contentTypeFor(f), data };
}

// ---------------------------------------------------------------------
// The outgoing mail (live or test)
// ---------------------------------------------------------------------
export interface Envelope {
  mail: OutgoingMail;
  /** SMTP RCPT TO list. */
  rcpt: string[];
}

/** Base Message-ID domain: the sender's own domain (gmail.com for the shared Gmail). */
export function messageIdDomain(smtpUser: string): string {
  return smtpUser.split('@')[1] ?? 'localhost';
}

/**
 * The mail as it goes out. Live: the recipients stored on the send. Test: To = the test address only,
 * no Cc, subject prefixed `[TEST] `, and the real recipients listed at the top of the body so the run
 * can be checked. Throws when a test envelope would reach anyone but the test address (defence in depth).
 */
export function buildEnvelope(cfg: Pick<SendConfig, 'mode' | 'testTo' | 'smtpUser' | 'fromName'>, s: ClaimedSend,
                              attachments: MailAttachment[], date: Date = new Date()): Envelope {
  const base = {
    from: cfg.smtpUser,
    fromName: cfg.fromName,
    messageId: s.message_id,
    inReplyTo: s.in_reply_to,
    references: s.references_ids ?? [],
    date,
    attachments,
  };
  if (cfg.mode === 'live') {
    const mail: OutgoingMail = { ...base, to: s.to_addresses, cc: s.cc_addresses, subject: s.subject, text: s.body };
    return { mail, rcpt: [...new Set([...s.to_addresses, ...s.cc_addresses].map((a) => a.toLowerCase()))] };
  }
  const testTo = cfg.testTo;
  if (!testTo) throw new Error('Test mode without a test address');
  const header = [
    'TEST SEND - this message was NOT sent to the insurer.',
    `Case: ${s.case_ref}`,
    `Would go to: ${s.to_addresses.join(', ')}`,
    `Cc: ${s.cc_addresses.length ? s.cc_addresses.join(', ') : '(none)'}`,
    `Subject: ${s.subject}`,
    '------------------------------------------------------------',
    '',
  ].join('\n');
  const mail: OutgoingMail = { ...base, to: [testTo], cc: [], subject: `[TEST] ${s.subject}`, text: header + s.body };
  const rcpt = [testTo];
  if (mail.to.length !== 1 || mail.to[0] !== testTo || mail.cc.length !== 0 || rcpt.some((r) => r !== testTo)) {
    throw new Error('Test mail would reach someone other than the test address');
  }
  return { mail, rcpt };
}

/** Database error → short text for logs (no values). */
export function dbErrorText(e: { code?: string; message?: string } | null | undefined): string {
  return e ? `${e.code ?? 'error'}${e.message ? `: ${e.message.slice(0, 200)}` : ''}` : 'unknown error';
}
