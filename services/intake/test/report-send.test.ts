// 8.2–8.4 shared pieces: templates and names, MIME, SMTP outcome classes, zip, delivery plan, pack names.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import PostalMime from 'postal-mime';
import { buildMime, encodeHeaderText, isMessageId, newMessageId } from '../../../supabase/functions/_shared/send/mime.ts';
import { MB, packNames, planDelivery } from '../../../supabase/functions/_shared/send/plan.ts';
import { normaliseAddress, renderTemplate, safeName } from '../../../supabase/functions/_shared/send/render.ts';
import { type Duplex, sendSmtp, SmtpRefused, SmtpUncertain } from '../../../supabase/functions/_shared/send/smtp.ts';
import { buildZip, crc32 } from '../../../supabase/functions/_shared/send/zip.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('render helpers', () => {
  it('fills {{name}} and flattens line breaks; unknown names are empty', () => {
    assert.equal(renderTemplate('Re: {{original_subject}} / {{x}}', { original_subject: 'A\r\nB' }), 'Re: A B / ');
    assert.equal(renderTemplate('{{insurer_claim_no}}_{{ insured_name }}_IR', { insurer_claim_no: 'C/1', insured_name: 'Ravi K' }), 'C/1_Ravi K_IR');
  });
  it('safeName keeps ASCII letters, digits and ._-', () => {
    assert.equal(safeName('IR/ WSN:1 ?'), 'IR_WSN_1');
    assert.equal(safeName('Zoë Ünal  क्लेम'), 'Zoe_Unal');
    assert.equal(safeName('///'), 'file');
    assert.ok(safeName('a'.repeat(200)).length <= 80);
  });
  it('normaliseAddress accepts plain addresses only', () => {
    assert.equal(normaliseAddress(' Claims@Insurer.EXAMPLE '), 'claims@insurer.example');
    assert.equal(normaliseAddress('Name <a@b.co>'), null);
    assert.equal(normaliseAddress('a@b.co\r\nBcc: x@y.zz'), null);
  });
});

describe('MIME', () => {
  const base = {
    from: 'toyaminvestigation@gmail.com', fromName: 'Toyam Investigation', to: ['claims@insurer.example'], cc: ['boss@insurer.example'],
    subject: 'Re: Investigation WSN-1', text: 'Please find the report.\nRegards', messageId: '<m1@gmail.com>',
    inReplyTo: '<ins-1@insurer.example>', references: ['<root@insurer.example>', '<ins-1@insurer.example>'], date: new Date('2026-11-15T10:00:00Z'),
  };
  it('builds a reply that a mail parser reads back (headers, body, attachments)', async () => {
    const pdf = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
    const raw = buildMime({ ...base, subject: 'Re: दावा WSN-1 — report', attachments: [{ filename: 'IR_WSN-1.pdf', contentType: 'application/pdf', data: pdf }, { filename: 'रिपोर्ट.docx', contentType: 'application/octet-stream', data: bytes('x') }] });
    assert.ok(/^[\x00-\x7f]*$/.test(raw), 'ASCII only');
    const m = await PostalMime.parse(raw);
    assert.equal(m.subject, 'Re: दावा WSN-1 — report');
    assert.equal(m.messageId, '<m1@gmail.com>');
    assert.equal(m.inReplyTo, '<ins-1@insurer.example>');
    assert.equal(m.references, '<root@insurer.example> <ins-1@insurer.example>');
    assert.equal(m.to?.[0].address, 'claims@insurer.example');
    assert.equal(m.cc?.[0].address, 'boss@insurer.example');
    assert.equal(m.from?.name, 'Toyam Investigation');
    assert.equal(m.text?.trim(), 'Please find the report.\nRegards');
    assert.equal(m.attachments.length, 2);
    assert.equal(m.attachments[0].filename, 'IR_WSN-1.pdf');
    assert.deepEqual(new Uint8Array(m.attachments[0].content as ArrayBuffer), pdf);
    assert.ok(raw.includes("filename*=UTF-8''%E0%A4%B0"), 'RFC 2231 name present; the plain name is an ASCII fallback');
  });
  it('a message without attachments is a single text part', async () => {
    const m = await PostalMime.parse(buildMime({ ...base, attachments: [] }));
    assert.equal(m.attachments.length, 0);
    assert.equal(m.text?.trim().split('\n')[0], 'Please find the report.');
  });
  it('refuses header injection and bad ids', () => {
    assert.throws(() => buildMime({ ...base, to: ['a@b.co\r\nBcc: x@y.zz'], attachments: [] }));
    assert.throws(() => buildMime({ ...base, messageId: 'no-brackets', attachments: [] }));
    const raw = buildMime({ ...base, subject: 'Hi\r\nBcc: evil@x.zz', attachments: [] });
    assert.ok(!/^Bcc:/m.test(raw));
    assert.equal(encodeHeaderText('plain'), 'plain');
    assert.ok(isMessageId(newMessageId('gmail.com')));
  });
});

/** A scripted SMTP server on the other end of a duplex. */
function fakeSmtp(o: { rcptFail?: string; dropAfterData?: boolean; dataCode?: number } = {}) {
  const log: string[] = [];
  let message = '';
  let inData = false;
  let buf = '';
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const out = new ReadableStream<Uint8Array>({ start(c) { ctl = c; c.enqueue(bytes('220 ready\r\n')); } });
  const say = (s: string) => ctl.enqueue(bytes(s + '\r\n'));
  const inbound = new WritableStream<Uint8Array>({
    write(chunk) {
      buf += new TextDecoder().decode(chunk);
      for (;;) {
        if (inData) {
          const i = buf.indexOf('\r\n.\r\n');
          if (i < 0) return;
          message = buf.slice(0, i);
          buf = buf.slice(i + 5);
          inData = false;
          if (o.dropAfterData) { ctl.close(); return; }
          say(`${o.dataCode ?? 250} 2.0.0 OK queued`);
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        log.push(line.replace(/^AUTH PLAIN .*/, 'AUTH PLAIN ***'));
        if (line.startsWith('EHLO')) say('250-smtp.example\r\n250 AUTH PLAIN');
        else if (line.startsWith('AUTH')) say('235 ok');
        else if (line.startsWith('MAIL')) say('250 ok');
        else if (line.startsWith('RCPT')) say(o.rcptFail && line.includes(o.rcptFail) ? '550 no such user' : '250 ok');
        else if (line === 'DATA') { say('354 go'); inData = true; }
        else if (line === 'QUIT') { say('221 bye'); }
      }
    },
  });
  const io: Duplex = { readable: out, writable: inbound };
  return { io, log, message: () => message };
}
const auth = { user: 'u@gmail.com', password: 'pw' };

describe('SMTP', () => {
  it('sends to every recipient, dot-stuffs, never logs the password', async () => {
    const s = fakeSmtp();
    const r = await sendSmtp(s.io, auth, { from: 'u@gmail.com', to: ['a@x.co', 'b@y.co'] }, 'Subject: x\r\n\r\n.hidden dot\r\nend');
    assert.ok(r.accepted.includes('250'));
    assert.deepEqual(s.log.filter((l) => l.startsWith('RCPT')), ['RCPT TO:<a@x.co>', 'RCPT TO:<b@y.co>']);
    assert.ok(s.log.includes('AUTH PLAIN ***'));
    assert.ok(s.message().includes('\r\n..hidden dot'));
  });
  it('a refused recipient is SmtpRefused: nothing went out', async () => {
    await assert.rejects(sendSmtp(fakeSmtp({ rcptFail: 'b@y.co' }).io, auth, { from: 'u@gmail.com', to: ['a@x.co', 'b@y.co'] }, 'x'), SmtpRefused);
  });
  it('a rejected message body is SmtpRefused', async () => {
    await assert.rejects(sendSmtp(fakeSmtp({ dataCode: 552 }).io, auth, { from: 'u@gmail.com', to: ['a@x.co'] }, 'x'), SmtpRefused);
  });
  it('a connection lost after the body was handed over is SmtpUncertain', async () => {
    await assert.rejects(sendSmtp(fakeSmtp({ dropAfterData: true }).io, auth, { from: 'u@gmail.com', to: ['a@x.co'] }, 'x'), SmtpUncertain);
  });
});

describe('zip', () => {
  it('crc32 matches the standard check value', () => {
    assert.equal(crc32(bytes('123456789')), 0xcbf43926);
  });
  it('produces an archive that unzip accepts, with stored and deflated entries and UTF-8 names', async () => {
    const jpg = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) % 256);
    const txt = bytes('hello hello hello hello '.repeat(200));
    const zip = await buildZip([
      { name: '01_Report.pdf', data: bytes('%PDF-1.4 fake') },
      { name: '02_Annexure_photo.jpg', data: jpg },
      { name: 'notes.txt', data: txt },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ]);
    assert.ok(zip.length < 3000 + 4800 + 400);                      // the text entry was deflated
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    const f = join(dir, 'a.zip');
    writeFileSync(f, zip);
    assert.match(execFileSync('unzip', ['-t', f]).toString(), /No errors detected/);
    assert.deepEqual(execFileSync('unzip', ['-Z1', f]).toString().trim().split('\n'), ['01_Report.pdf', '02_Annexure_photo.jpg', 'notes.txt', 'empty.txt']);
    assert.deepEqual(new Uint8Array(execFileSync('unzip', ['-p', f, '02_Annexure_photo.jpg'])), jpg);
  });
});

describe('delivery plan (8.3)', () => {
  const max = 18 * MB;
  it('attaches the report and the annexure zip when both fit', () => {
    assert.deepEqual(planDelivery({ reportBytes: [2 * MB, MB], annexZipBytes: 10 * MB, attachMaxBytes: max }), { kind: 'attached', attachReport: true, attachAnnex: true });
  });
  it('no annexures: only the report', () => {
    assert.deepEqual(planDelivery({ reportBytes: [MB], annexZipBytes: 0, attachMaxBytes: max }), { kind: 'attached', attachReport: true, attachAnnex: false });
  });
  it('annexures that do not fit go as a secure link; the report is still attached', () => {
    assert.deepEqual(planDelivery({ reportBytes: [3 * MB], annexZipBytes: 16 * MB, attachMaxBytes: max }), { kind: 'link', attachReport: true, attachAnnex: false, linkWhat: 'annexures' });
  });
  it('a report over the limit goes in one pack behind a link', () => {
    assert.deepEqual(planDelivery({ reportBytes: [19 * MB], annexZipBytes: MB, attachMaxBytes: max }), { kind: 'link', attachReport: false, attachAnnex: false, linkWhat: 'everything' });
  });
  it('exactly at the limit still attaches', () => {
    assert.equal(planDelivery({ reportBytes: [8 * MB], annexZipBytes: 10 * MB, attachMaxBytes: max }).kind, 'attached');
  });
});

describe('portal pack names (8.4)', () => {
  it('numbers the report first, then annexures in report order, ASCII and unique', () => {
    const ann = [
      { position: 2, section_key: 'garage', section_title: 'Garage visit', caption: 'Front bumper', original_filename: 'IMG_1.JPG', mime_type: 'image/jpeg' },
      { position: 1, section_key: 'driver', section_title: 'Driver', caption: null, original_filename: 'dl.pdf', mime_type: 'application/pdf' },
      { position: 3, section_key: 'garage', section_title: 'Garage visit', caption: 'Front bumper', original_filename: 'IMG_2.JPG', mime_type: 'image/jpeg' },
    ];
    const n = packNames('WSN-1_Ravi Kumar_IR', ['pdf', 'docx'], ann, true);
    assert.deepEqual(n.report, ['01_WSN-1_Ravi_Kumar_IR.pdf', '02_WSN-1_Ravi_Kumar_IR.docx']);
    assert.deepEqual(n.annexures, ['04_Annexure_Garage_visit_Front_bumper.jpg', '03_Annexure_Driver.pdf', '05_Annexure_Garage_visit_Front_bumper.jpg']);
    assert.ok(n.annexures.every((x) => /^[A-Za-z0-9._-]+$/.test(x)));
  });
  it('an annexure-only pack starts at 01', () => {
    const n = packNames('x', ['pdf'], [{ position: 1, section_key: null, caption: null, original_filename: null, mime_type: 'image/png' }], false);
    assert.deepEqual(n, { report: [], annexures: ['01_Annexure_file.png'] });
  });
});
