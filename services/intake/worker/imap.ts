// Minimal IMAP4rev1 client for the Gmail relay (LOGIN, SELECT, UID SEARCH, UID FETCH, LOGOUT).
// Works over any byte duplex ({ readable, writable } Web Streams), e.g. a Cloudflare
// `connect()` socket with secureTransport "on", or a fake server in tests.

export interface Duplex {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close?: () => Promise<void> | void;
}

export interface ImapResponse {
  status: 'OK' | 'NO' | 'BAD';
  text: string;
  untagged: string[];              // untagged lines (literals replaced by {n})
  literals: Uint8Array[];          // literals in order of appearance
}

export interface FetchedMessage {
  uid: number;
  raw: Uint8Array;
  gmailThreadId: string | null;
  gmailMessageId: string | null;
}

const CRLF = new Uint8Array([13, 10]);
const latin1 = new TextDecoder('latin1');

export class ImapError extends Error {}

export class ImapClient {
  private io: Duplex;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buf = new Uint8Array(0);
  private tagNo = 0;

  constructor(io: Duplex) {
    this.io = io;
    this.reader = io.readable.getReader();
    this.writer = io.writable.getWriter();
  }

  // ---- low level ------------------------------------------------------
  private async fill(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done) throw new ImapError('Connection closed by server');
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf);
    next.set(value, this.buf.length);
    this.buf = next;
  }

  private indexOfCrlf(): number {
    for (let i = 0; i + 1 < this.buf.length; i++) if (this.buf[i] === 13 && this.buf[i + 1] === 10) return i;
    return -1;
  }

  private async readLine(): Promise<string> {
    let i: number;
    while ((i = this.indexOfCrlf()) < 0) await this.fill();
    const line = latin1.decode(this.buf.subarray(0, i));
    this.buf = this.buf.subarray(i + 2);
    return line;
  }

  private async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** One logical response line: joins literal continuations, collecting literal bytes. */
  private async readResponse(literals: Uint8Array[]): Promise<string> {
    let line = await this.readLine();
    let m: RegExpExecArray | null;
    while ((m = /\{(\d+)\}$/.exec(line)) !== null) {
      literals.push(await this.readBytes(parseInt(m[1], 10)));
      line = line + '\u0000' + (await this.readLine());   // \u0000 marks where the literal was
    }
    return line;
  }

  private async send(text: string): Promise<void> {
    await this.writer.write(new TextEncoder().encode(text));
    await this.writer.write(CRLF);
  }

  async command(cmd: string): Promise<ImapResponse> {
    const tag = `A${String(++this.tagNo).padStart(4, '0')}`;
    await this.send(`${tag} ${cmd}`);
    const untagged: string[] = [];
    const literals: Uint8Array[] = [];
    for (;;) {
      const line = await this.readResponse(literals);
      if (line.startsWith(tag + ' ')) {
        const m = /^\S+ (OK|NO|BAD)\b ?(.*)$/.exec(line);
        if (!m) throw new ImapError(`Bad tagged response: ${line}`);
        return { status: m[1] as ImapResponse['status'], text: m[2], untagged, literals };
      }
      untagged.push(line);
    }
  }

  private async ok(cmd: string, redacted?: string): Promise<ImapResponse> {
    const r = await this.command(cmd);
    if (r.status !== 'OK') throw new ImapError(`${redacted ?? cmd.split(' ')[0]} failed: ${r.status} ${r.text}`);
    return r;
  }

  // ---- commands ---------------------------------------------------------
  async greeting(): Promise<string> {
    const line = await this.readLine();
    if (!/^\* (OK|PREAUTH)\b/.test(line)) throw new ImapError(`Unexpected greeting: ${line}`);
    return line;
  }

  async login(user: string, password: string): Promise<void> {
    const q = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    await this.ok(`LOGIN ${q(user)} ${q(password)}`, 'LOGIN');
  }

  async select(mailbox: string): Promise<{ uidValidity: number; uidNext: number; exists: number }> {
    const r = await this.ok(`SELECT "${mailbox}"`);
    const all = r.untagged.join('\n') + '\n' + r.text;
    const num = (re: RegExp) => { const m = re.exec(all); return m ? parseInt(m[1], 10) : NaN; };
    return { uidValidity: num(/UIDVALIDITY (\d+)/i), uidNext: num(/UIDNEXT (\d+)/i), exists: num(/\* (\d+) EXISTS/i) };
  }

  async uidSearch(criteria: string): Promise<number[]> {
    const r = await this.ok(`UID SEARCH ${criteria}`);
    const out: number[] = [];
    for (const l of r.untagged) {
      const m = /^\* SEARCH\b(.*)$/i.exec(l);
      if (m) for (const n of m[1].trim().split(/\s+/)) if (/^\d+$/.test(n)) out.push(parseInt(n, 10));
    }
    return out.sort((a, b) => a - b);
  }

  /** Full raw message with Gmail thread/message ids (X-GM-EXT-1). Does not set \Seen. */
  async fetchMessage(uid: number): Promise<FetchedMessage | null> {
    const r = await this.ok(`UID FETCH ${uid} (UID X-GM-THRID X-GM-MSGID BODY.PEEK[])`);
    for (let i = 0, lit = 0; i < r.untagged.length; i++) {
      const line = r.untagged[i];
      const holes = (line.match(/\u0000/g) ?? []).length;
      if (/^\* \d+ FETCH \(/i.test(line) && new RegExp(`\\bUID ${uid}\\b`).test(line) && holes > 0) {
        const raw = r.literals[lit + holes - 1];
        const thr = /X-GM-THRID (\d+)/i.exec(line)?.[1] ?? null;
        const msg = /X-GM-MSGID (\d+)/i.exec(line)?.[1] ?? null;
        return { uid, raw, gmailThreadId: thr, gmailMessageId: msg };
      }
      lit += holes;
    }
    return null;
  }

  async logout(): Promise<void> {
    try { await this.command('LOGOUT'); } catch { /* server may close first */ }
    try { this.writer.releaseLock(); this.reader.releaseLock(); await this.io.close?.(); } catch { /* ignore */ }
  }
}
