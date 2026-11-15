// SMTP submission of one message to several recipients over an implicit-TLS byte duplex
// (smtp.gmail.com:465, AUTH PLAIN with an app password). Used by the `report-send` function.
//
// Errors tell the caller whether sending again is safe:
//   SmtpRefused    the server said no before it accepted the message body: nothing was delivered
//   SmtpUncertain  the body was handed over but the final answer never came: the mail may have gone out
export interface Duplex {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close?: () => Promise<void> | void;
}
export class SmtpRefused extends Error {}
export class SmtpUncertain extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();

function plain(user: string, password: string): string {
  let s = '';
  for (const b of enc.encode(`\0${user}\0${password}`)) s += String.fromCharCode(b);
  return btoa(s);
}

export async function sendSmtp(io: Duplex, auth: { user: string; password: string },
                               envelope: { from: string; to: string[] }, message: string,
                               opts: { helo?: string; timeoutMs?: number } = {}): Promise<{ accepted: string }> {
  const reader = io.readable.getReader();
  const writer = io.writable.getWriter();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let buf = '';
  let dataSent = false;
  const read = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('SMTP timeout')), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const reply = async (): Promise<{ code: number; text: string }> => {
    const lines: string[] = [];
    for (;;) {
      let i: number;
      while ((i = buf.indexOf('\r\n')) < 0) {
        const { value, done } = await read();
        if (done) throw new Error('Connection closed by server');
        buf += dec.decode(value, { stream: true });
      }
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      lines.push(line);
      if (!/^\d{3}-/.test(line)) return { code: parseInt(line.slice(0, 3), 10), text: lines.join('\n') };
    }
  };
  const step = async (line: string | null, code: number, what: string) => {
    if (line !== null) await writer.write(enc.encode(line + '\r\n'));
    const r = await reply();
    if (r.code !== code) throw new SmtpRefused(`${what}: ${r.text.slice(0, 200)}`);
    return r;
  };
  try {
    try {
      await step(null, 220, 'greeting');
      await step(`EHLO ${opts.helo ?? 'toyam-send'}`, 250, 'EHLO');
      await step(`AUTH PLAIN ${plain(auth.user, auth.password)}`, 235, 'AUTH');
      await step(`MAIL FROM:<${envelope.from}> SIZE=${message.length}`, 250, 'MAIL');
      for (const r of envelope.to) await step(`RCPT TO:<${r}>`, 250, 'RCPT');
      await step('DATA', 354, 'DATA');
    } catch (e) {
      if (e instanceof SmtpRefused) throw e;
      throw new SmtpRefused(`before the message was handed over: ${(e as Error).message}`);
    }
    dataSent = true;
    await writer.write(enc.encode(message.replace(/^\./gm, '..') + '\r\n.\r\n'));
    const r = await reply();
    if (r.code !== 250) throw new SmtpRefused(`message: ${r.text.slice(0, 200)}`);
    try { await writer.write(enc.encode('QUIT\r\n')); } catch { /* the mail is accepted */ }
    return { accepted: r.text };
  } catch (e) {
    if (e instanceof SmtpRefused) throw e;
    if (dataSent) throw new SmtpUncertain(`outcome unknown after the message was handed over: ${(e as Error).message}`);
    throw new SmtpRefused((e as Error).message);
  } finally {
    try { writer.releaseLock(); reader.releaseLock(); await io.close?.(); } catch { /* ignore */ }
  }
}
