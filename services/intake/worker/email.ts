// Push intake (D33): Gmail auto-forwards insurer mail to an Email Routing address; Cloudflare
// calls the Worker's email() handler only when a message arrives. No Cloudflare imports here,
// so it is tested in Node; index.ts wires it to ForwardableEmailMessage.

export interface InboundEmail {
  from: string;                                    // envelope sender (MAIL FROM)
  to: string;                                      // envelope recipient
  raw: ReadableStream<Uint8Array> | Uint8Array;
}

export interface EmailEnv {
  INTAKE_URL: string;
  INTAKE_SECRET: string;
  GMAIL_USER: string;                              // the shared mailbox that forwards
  ALLOWED_SENDERS?: string;                        // optional extra envelope senders, comma separated
}

export type EmailOutcome =
  | { kind: 'relayed'; status: number }
  | { kind: 'confirmation'; code: string | null; link: string | null }
  | { kind: 'rejected_sender'; sender: string }
  | { kind: 'failed'; status?: number; error?: string };

const GOOGLE_CONFIRMATION_SENDER = 'forwarding-noreply@google.com';

/** "name+caf_=x=y@gmail.com" → "name@gmail.com" (Gmail forwarding adds a +tag to the envelope sender). */
export function baseAddress(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (at < 0) return a;
  return a.slice(0, at).replace(/\+.*$/, '') + a.slice(at);
}

async function bytesOf(raw: InboundEmail['raw']): Promise<Uint8Array> {
  return raw instanceof Uint8Array ? raw : new Uint8Array(await new Response(raw as unknown as BodyInit).arrayBuffer());
}

/** Gmail's "confirm forwarding" mail: surface the code / link in the logs, never relay it. */
export function confirmationDetails(text: string): { code: string | null; link: string | null } {
  // The body is usually quoted-printable and/or HTML: undo soft line breaks and =XX escapes, drop tags.
  const decoded = text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  const plain = decoded.replace(/<[^>]*>/g, ' ');
  const code = /^Subject:[^\r\n]*\(#(\d{6,12})\)/im.exec(text)?.[1]      // "(#123456789) Gmail Forwarding Confirmation"
    ?? /confirmation code\W{0,20}(\d{6,12})/i.exec(plain)?.[1] ?? null;
  const link = /(https:\/\/mail(?:-settings)?\.google\.com\/mail\/[^\s"'<>]+)/i.exec(decoded)?.[1] ?? null;   // before tags go (href)
  return { code, link };
}

export async function handleInbound(msg: InboundEmail, env: EmailEnv, post: typeof fetch = fetch): Promise<EmailOutcome> {
  const sender = baseAddress(msg.from);

  if (sender === GOOGLE_CONFIRMATION_SENDER) {
    const text = new TextDecoder().decode(await bytesOf(msg.raw));
    return { kind: 'confirmation', ...confirmationDetails(text) };
  }

  const allowed = new Set(
    [env.GMAIL_USER, ...(env.ALLOWED_SENDERS ?? '').split(',')].map((s) => baseAddress(s)).filter((s) => s !== ''),
  );
  if (!allowed.has(sender)) return { kind: 'rejected_sender', sender };

  const raw = await bytesOf(msg.raw);
  try {
    const res = await post(env.INTAKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822', 'x-intake-secret': env.INTAKE_SECRET },
      body: raw as unknown as BodyInit,
    });
    // On failure the message is not bounced: the hourly IMAP safety net picks it up.
    return res.ok ? { kind: 'relayed', status: res.status } : { kind: 'failed', status: res.status };
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}
