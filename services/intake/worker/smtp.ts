// Minimal SMTP submission client (implicit TLS, AUTH PLAIN) for one alert email at a time (D39).
// Used with Gmail (smtp.gmail.com:465) and the shared mailbox's app password, so it needs no DNS.
// Works over any byte duplex: a Cloudflare `connect()` socket with secureTransport "on", or a
// fake server in tests.
import type { Duplex } from './imap.ts';

export class SmtpError extends Error {}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;          // ASCII
  text: string;             // UTF-8 plain text
}

const enc = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** RFC 5322 message; body base64-encoded so any UTF-8 is safe, wrapped at 76 columns. */
export function buildMessage(m: MailMessage, now = new Date(), id: string = crypto.randomUUID()): string {
  const domain = m.from.split('@')[1] ?? 'localhost';
  const body = base64(enc.encode(m.text)).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${m.from}`, `To: ${m.to}`, `Subject: ${m.subject.replace(/[\r\n]+/g, ' ')}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
    '', body,
  ].join('\r\n');
}

export async function sendSmtp(io: Duplex, auth: { user: string; password: string }, m: MailMessage, helo = 'toyam-intake'): Promise<void> {
  const reader = io.readable.getReader();
  const writer = io.writable.getWriter();
  const dec = new TextDecoder();
  let buf = '';
  const reply = async (): Promise<{ code: number; text: string }> => {
    const lines: string[] = [];
    for (;;) {
      let i: number;
      while ((i = buf.indexOf('\r\n')) < 0) {
        const { value, done } = await reader.read();
        if (done) throw new SmtpError('Connection closed by server');
        buf += dec.decode(value, { stream: true });
      }
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      lines.push(line);
      if (!/^\d{3}-/.test(line)) return { code: parseInt(line.slice(0, 3), 10), text: lines.join('\n') };
    }
  };
  const expect = async (code: number, what: string) => {
    const r = await reply();
    if (r.code !== code) throw new SmtpError(`${what}: ${r.text}`);
  };
  const cmd = async (line: string, code: number, what = line.split(' ')[0]) => {
    await writer.write(enc.encode(line + '\r\n'));
    await expect(code, what);
  };
  try {
    await expect(220, 'greeting');
    await cmd(`EHLO ${helo}`, 250);
    await cmd(`AUTH PLAIN ${base64(enc.encode(`\0${auth.user}\0${auth.password}`))}`, 235, 'AUTH');
    await cmd(`MAIL FROM:<${m.from}>`, 250, 'MAIL');
    await cmd(`RCPT TO:<${m.to}>`, 250, 'RCPT');
    await cmd('DATA', 354);
    const data = buildMessage(m).replace(/^\./gm, '..');                     // dot-stuffing
    await cmd(`${data}\r\n.`, 250, 'message');
    await writer.write(enc.encode('QUIT\r\n'));
  } finally {
    try { writer.releaseLock(); reader.releaseLock(); await io.close?.(); } catch { /* ignore */ }
  }
}
