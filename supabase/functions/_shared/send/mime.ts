// RFC 5322 / MIME builder for the report email (8.2): text body + attachments, reply headers.
// ASCII output only (bodies and attachments are base64), so the message can be sent over any SMTP
// connection and measured in bytes. Header values never contain line breaks (no header injection).
import { normaliseAddress } from './render.ts';

export interface MailAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface OutgoingMail {
  from: string;                 // address only
  fromName?: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  messageId: string;            // <local@domain>
  inReplyTo?: string | null;
  references?: string[];
  date?: Date;
  attachments: MailAttachment[];
}

const enc = new TextEncoder();

export function base64(bytes: Uint8Array): string {
  let out = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) out += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(out);
}

export function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, '$&\r\n');
}

function headerSafe(s: string): string {
  return s.replace(/[\r\n\0]+/g, ' ').trim();
}

/** RFC 2047 encoded-word for non-ASCII header text; plain text stays plain. Long text is split by character. */
export function encodeHeaderText(s: string): string {
  const v = headerSafe(s);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words: string[] = [];
  let cur = '';
  for (const ch of v) {
    if (enc.encode(cur + ch).length > 42) { words.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${base64(enc.encode(w))}?=`).join('\r\n ');
}

function asciiFallback(name: string): string {
  return headerSafe(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

function rfc2231(name: string): string {
  return encodeURIComponent(headerSafe(name)).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function addressList(list: string[]): string {
  return list.map((a) => {
    const n = normaliseAddress(a);
    if (!n) throw new Error(`Invalid address: ${a.slice(0, 60)}`);
    return n;
  }).join(', ');
}

export function isMessageId(s: string): boolean {
  return /^<[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+>$/.test(s);
}

export function newMessageId(domain: string, id: string = crypto.randomUUID()): string {
  return `<${id}@${domain}>`;
}

/** Whole message as a CRLF string. Throws on invalid addresses or Message-IDs. */
export function buildMime(m: OutgoingMail, boundary: string = `=_toyam_${crypto.randomUUID().replace(/-/g, '')}`): string {
  if (!isMessageId(m.messageId)) throw new Error('Invalid Message-ID');
  const refs = (m.references ?? []).filter(isMessageId);
  const from = normaliseAddress(m.from);
  if (!from) throw new Error('Invalid sender address');
  const fromHeader = m.fromName ? `${encodeHeaderText(m.fromName)} <${from}>` : from;
  const head: string[] = [
    `From: ${fromHeader}`,
    `To: ${addressList(m.to)}`,
    ...(m.cc.length ? [`Cc: ${addressList(m.cc)}`] : []),
    `Subject: ${encodeHeaderText(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${m.messageId}`,
    ...(m.inReplyTo && isMessageId(m.inReplyTo) ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(refs.length ? [`References: ${refs.join(' ')}`] : []),
    'MIME-Version: 1.0',
  ];
  const textPart = [
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
    wrap76(base64(enc.encode(m.text.replace(/\r?\n/g, '\r\n')))),
  ].join('\r\n');
  if (m.attachments.length === 0) return [...head, textPart].join('\r\n');
  const parts = [`--${boundary}\r\n${textPart}`];
  for (const a of m.attachments) {
    const ascii = asciiFallback(a.filename);
    parts.push([
      `--${boundary}`,
      `Content-Type: ${headerSafe(a.contentType)}; name="${ascii}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${rfc2231(a.filename)}`,
      '', wrap76(base64(a.data)),
    ].join('\r\n'));
  }
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', parts.join('\r\n') + `--${boundary}--\r\n`].join('\r\n');
}
