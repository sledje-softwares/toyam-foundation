// Adapter from postal-mime output to ParsedEmail (structural types: no import of the library,
// so this file runs in Deno and Node alike). Also SHA-256 helpers on WebCrypto.
import type { Address, EmailAttachment, ParsedEmail } from './types.ts';

interface PmAddress { address?: string; name?: string; group?: PmAddress[] }
interface PmHeader { key: string; value: string }
interface PmAttachment {
  filename?: string | null;
  mimeType?: string;
  disposition?: string | null;
  contentId?: string;
  content: ArrayBuffer | Uint8Array | string;
}
export interface PostalMimeEmail {
  headers?: PmHeader[];
  from?: PmAddress;
  to?: PmAddress[];
  cc?: PmAddress[];
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  date?: string;
  html?: string;
  text?: string;
  attachments?: PmAttachment[];
}

function flat(list: PmAddress[] | undefined): Address[] {
  const out: Address[] = [];
  for (const a of list ?? []) {
    if (a.group) out.push(...flat(a.group));
    else if (a.address) out.push({ address: a.address.toLowerCase(), name: a.name || undefined });
  }
  return out;
}

function stripId(id: string | undefined | null): string | null {
  if (!id) return null;
  const t = id.trim().replace(/^<|>$/g, '');
  return t === '' ? null : t;
}

export function bytesOf(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface MimeExtras {
  threadId?: string | null;     // X-GM-THRID from the IMAP relay
  gmailMessageId?: string | null;
}

/** Converts a postal-mime result; attachment hashes are computed here (storage paths are not). */
export async function fromPostalMime(pm: PostalMimeEmail, extras: MimeExtras = {}): Promise<ParsedEmail> {
  const refs = (pm.references ?? '').match(/<[^>]+>/g)?.map((r) => r.slice(1, -1)) ?? [];
  const messageId = stripId(pm.messageId) ?? (extras.gmailMessageId ? `gmail-${extras.gmailMessageId}` : null);
  if (!messageId) throw new Error('Message has no Message-ID and no Gmail message id');
  const date = pm.date && !Number.isNaN(Date.parse(pm.date)) ? new Date(pm.date).toISOString() : new Date().toISOString();
  const attachments: EmailAttachment[] = [];
  for (const a of pm.attachments ?? []) {
    const bytes = bytesOf(a.content);
    attachments.push({
      filename: a.filename ?? '',
      mimeType: (a.mimeType ?? 'application/octet-stream').toLowerCase(),
      size: bytes.byteLength,
      contentId: a.contentId ?? undefined,
      disposition: a.disposition === 'inline' || a.disposition === 'attachment' ? a.disposition : null,
      sha256: await sha256Hex(bytes),
    });
  }
  const from = flat(pm.from ? [pm.from] : [])[0] ?? { address: '' };
  return {
    messageId,
    threadId: extras.threadId ?? null,
    inReplyTo: stripId(pm.inReplyTo),
    references: refs,
    from,
    to: flat(pm.to),
    cc: flat(pm.cc),
    subject: (pm.subject ?? '').replace(/\s+/g, ' ').trim(),
    date,
    text: pm.text ?? null,
    html: pm.html ?? null,
    attachments,
  };
}
