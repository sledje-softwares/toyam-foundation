import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../outbox/sha256';
import { needsCompression, nextPass, PASSES, resizeFor } from './compress';
import { attachState, chipsFrom, openTaskId, UNKNOWN_TEXT } from './context';
import { DraftStore } from './draft';
import { cleanExif, parseExifDate, pickCaptureTime } from './exif';
import { EMPTY_SHA256, SELF_TEST_BYTES, SELF_TEST_SHA256, sha256OfFile, type FileDigester } from './hash';
import { buildNewItems, gpsFrom, MAX_FILES_PER_MESSAGE, NO_TASK_TEXT, originalName, sandboxName, type PreparedFile } from './item';
import { checkFile, evidenceTypeFor, extFor, MAX_BYTES, MB, MIME_EXT, mimeOf } from './limits';

const IST = -330; // Date.getTimezoneOffset() in India
const NOW = Date.parse('2026-11-14T12:00:00Z');

describe('hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // stands in for File.digest('SHA-256'): reads the file bytes from disk
  const nodeDigest: FileDigester = async (uri) => createHash('sha256').update(readFileSync(uri)).digest('hex');

  it('the self-test vector is the SHA-256 of bytes 0x00..0xff (node:crypto and the pure implementation)', () => {
    const bytes = SELF_TEST_BYTES();
    expect(bytes.length).toBe(256);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SELF_TEST_SHA256);
    expect(sha256Hex(bytes)).toBe(SELF_TEST_SHA256);
    expect(sha256Hex(new Uint8Array())).toBe(EMPTY_SHA256);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the file bytes, not a base64 text of them', async () => {
    const p = join(dir, 'v.bin');
    writeFileSync(p, SELF_TEST_BYTES());
    expect(await sha256OfFile(p, nodeDigest)).toBe(SELF_TEST_SHA256);
    const base64 = Buffer.from(SELF_TEST_BYTES()).toString('base64');
    expect(sha256Hex(base64)).not.toBe(SELF_TEST_SHA256); // the trap this contract avoids
  });

  it('normalises upper case and refuses malformed digests', async () => {
    expect(await sha256OfFile('x', async () => ` ${SELF_TEST_SHA256.toUpperCase()}\n`)).toBe(SELF_TEST_SHA256);
    await expect(sha256OfFile('x', async () => 'abc')).rejects.toThrow();
    await expect(sha256OfFile('x', async () => Buffer.from(SELF_TEST_BYTES()).toString('base64'))).rejects.toThrow();
  });
});

describe('limits', () => {
  it('match the evidence-upload edge function exactly', async () => {
    // loaded at run time so the app's tsc does not type-check the Deno shared code
    const shared = new URL('../../../../supabase/functions/_shared/evidence-upload/logic.ts', import.meta.url).href;
    const server = (await import(/* @vite-ignore */ shared)) as { MIME_EXT: unknown; MAX_BYTES: unknown };
    expect(MIME_EXT).toEqual(server.MIME_EXT);
    expect(MAX_BYTES).toEqual(server.MAX_BYTES);
  });

  it('checks type, emptiness and the family cap', () => {
    expect(checkFile('image/jpeg', 800_000)).toEqual({ ok: true });
    expect(checkFile('image/jpeg', 20 * MB)).toEqual({ ok: true });
    expect(checkFile('image/jpeg', 20 * MB + 1)).toMatchObject({ ok: false, reason: 'too_large', message: expect.stringContaining('20 MB') });
    expect(checkFile('application/pdf', 25 * MB + 1)).toMatchObject({ ok: false, reason: 'too_large' });
    expect(checkFile('application/pdf', 0)).toMatchObject({ ok: false, reason: 'empty' });
    expect(checkFile('application/zip', 10)).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(checkFile('IMAGE/JPEG; q=1', 10)).toEqual({ ok: true });
  });

  it('guesses the mime type from the name when the picker gives none', () => {
    expect(mimeOf(null, 'Claim Form.PDF')).toBe('application/pdf');
    expect(mimeOf('application/octet-stream', 'a.jpeg')).toBe('image/jpeg');
    expect(mimeOf('image/jpg', null)).toBe('image/jpeg');
    expect(mimeOf(undefined, 'notes.txt')).toBe('');
    expect(extFor('image/heic')).toBe('heic');
    expect(evidenceTypeFor('application/pdf')).toBe('document');
    expect(evidenceTypeFor('image/png')).toBe('photo');
  });
});

describe('exif capture time', () => {
  it('reads DateTimeOriginal in the phone zone when EXIF has no offset', () => {
    expect(new Date(parseExifDate('2026:11:10 15:30:00', null, IST)!).toISOString()).toBe('2026-11-10T10:00:00.000Z');
  });

  it('uses OffsetTimeOriginal when present', () => {
    expect(pickCaptureTime({ DateTimeOriginal: '2026:11:10 15:30:00', OffsetTimeOriginal: '+00:00' }, null, NOW, IST)).toBe('2026-11-10T15:30:00.000Z');
    expect(pickCaptureTime({ DateTimeOriginal: '2026:11:10 05:00:00', OffsetTimeOriginal: '-04:00' }, null, NOW, IST)).toBe('2026-11-10T09:00:00.000Z');
  });

  it('falls back to Digitized, DateTime, file time, then now', () => {
    expect(pickCaptureTime({ DateTimeDigitized: '2026:11:09 10:00:00' }, null, NOW, 0)).toBe('2026-11-09T10:00:00.000Z');
    expect(pickCaptureTime({ DateTime: '2026:11:08 10:00:00' }, null, NOW, 0)).toBe('2026-11-08T10:00:00.000Z');
    const fileTime = Date.parse('2026-11-01T08:00:00Z');
    expect(pickCaptureTime({ DateTimeOriginal: '0000:00:00 00:00:00' }, fileTime, NOW, IST)).toBe('2026-11-01T08:00:00.000Z');
    expect(pickCaptureTime(null, null, NOW, IST)).toBe('2026-11-14T12:00:00.000Z');
  });

  it('ignores implausible stamps (before 2000, more than a day ahead)', () => {
    expect(pickCaptureTime({ DateTimeOriginal: '1999:12:31 23:00:00' }, null, NOW, 0)).toBe(new Date(NOW).toISOString());
    expect(pickCaptureTime({ DateTimeOriginal: '2026:11:20 10:00:00' }, null, NOW, 0)).toBe(new Date(NOW).toISOString());
    expect(parseExifDate('garbage', null, 0)).toBeNull();
    expect(parseExifDate('2026:13:01 10:00:00', null, 0)).toBeNull();
  });

  it('keeps primitive EXIF tags and drops binary blobs', () => {
    expect(cleanExif({ Make: 'Samsung', ISO: 100, Flash: false, MakerNote: 'x'.repeat(5000), Thumb: { a: 1 }, NaN: Number.NaN })).toEqual({ Make: 'Samsung', ISO: 100, Flash: false });
    expect(cleanExif({})).toBeUndefined();
    expect(cleanExif(null)).toBeUndefined();
  });
});

describe('compression plan', () => {
  it('always compresses camera photos, picked images only when large', () => {
    expect(needsCompression('camera', 'image/jpeg', 500_000, 1000, 800)).toBe(true);
    expect(needsCompression('picked', 'image/jpeg', 500_000, 1600, 1200)).toBe(false);
    expect(needsCompression('picked', 'image/jpeg', 3 * MB, 1600, 1200)).toBe(true);
    expect(needsCompression('picked', 'image/png', 500_000, 4000, 3000)).toBe(true);
    expect(needsCompression('picked', 'application/pdf', 9 * MB, 0, 0)).toBe(false);
  });

  it('resizes the long edge only, never enlarges', () => {
    expect(resizeFor(4000, 3000, 2048)).toEqual({ width: 2048 });
    expect(resizeFor(3000, 4000, 2048)).toEqual({ height: 2048 });
    expect(resizeFor(1024, 768, 2048)).toBeNull();
    expect(resizeFor(0, 0, 2048)).toEqual({ width: 2048 });
  });

  it('steps down while above 1 MB, then keeps the last result', () => {
    expect(nextPass(0, 900_000)).toBeNull();
    expect(nextPass(0, 1.4 * MB)).toBe(1);
    expect(nextPass(PASSES.length - 1, 1.4 * MB)).toBeNull();
  });
});

const file = (sha: string, over: Partial<PreparedFile> = {}): PreparedFile => ({
  local_path: `file:///data/outbox/${sha}.jpg`, sha256: sha.padEnd(64, '0'), size_bytes: 700_000, mime_type: 'image/jpeg', ext: 'jpg',
  evidence_type: 'photo', device_captured_at: '2026-11-14T10:00:00.000Z', gps: null, capture_source: 'gallery',
  original_filename: null, checklist_item_id: null, ...over,
});

describe('NewItem builder', () => {
  it('builds a text-only message, also on a completed case', () => {
    expect(buildNewItems({ caseId: 'c', taskId: null, text: '  On my way  ', categoryCode: 'rc', files: [] })).toEqual({
      ok: true, items: [{ case_id: 'c', task_id: null, kind: 'text', caption: 'On my way', category_code: null, files: [] }],
    });
  });

  it('refuses an empty message and files without an open task', () => {
    expect(buildNewItems({ caseId: 'c', taskId: 't', text: '   ', categoryCode: null, files: [] })).toMatchObject({ ok: false });
    expect(buildNewItems({ caseId: 'c', taskId: null, text: '', categoryCode: null, files: [file('a')] })).toEqual({ ok: false, message: NO_TASK_TEXT });
  });

  it('puts the caption and chip on a media message; gallery and camera files alike (D18)', () => {
    const r = buildNewItems({ caseId: 'c', taskId: 't', text: 'RC front', categoryCode: 'rc', files: [file('a', { capture_source: 'camera' }), file('b')] });
    expect(r).toMatchObject({ ok: true, items: [{ kind: 'media', caption: 'RC front', category_code: 'rc', task_id: 't' }] });
    if (r.ok) expect(r.items[0]!.files.map((f) => f.capture_source)).toEqual(['camera', 'gallery']);
  });

  it('drops a file picked twice and splits more than 30 files', () => {
    const many = Array.from({ length: 31 }, (_, i) => file(i.toString(16).padStart(2, '0')));
    const r = buildNewItems({ caseId: 'c', taskId: 't', text: 'set', categoryCode: null, files: [...many, many[0]!] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.map((i) => i.files.length)).toEqual([MAX_FILES_PER_MESSAGE, 1]);
    expect(r.items.map((i) => i.caption)).toEqual(['set', null]);
  });

  it('names sandbox files safely and camera shots readably', () => {
    expect(sandboxName('3F2A-../x', 'JPG')).toBe('3f2a-.jpg');
    expect(() => sandboxName('../', 'jpg')).toThrow();
    expect(originalName('camera', null, '2026-11-14T10:05:09.123Z', 'jpg')).toBe('IMG_20261114_100509Z.jpg');
    expect(originalName('gallery', ' claim.pdf ', '2026-11-14T10:05:09.123Z', 'pdf')).toBe('claim.pdf');
    expect(originalName('gallery', null, '2026-11-14T10:05:09.123Z', 'jpg')).toBeNull();
  });

  it('maps GPS coordinates', () => {
    expect(gpsFrom({ latitude: 19.07, longitude: 72.87, accuracy: 12.6 })).toEqual({ latitude: 19.07, longitude: 72.87, accuracy_m: 13 });
    expect(gpsFrom({ latitude: 19.07, longitude: 72.87, accuracy: null })).toEqual({ latitude: 19.07, longitude: 72.87, accuracy_m: null });
    expect(gpsFrom(null)).toBeNull();
  });
});

describe('case context', () => {
  it('picks the newest open task', () => {
    expect(openTaskId([
      { id: 'old', status: 'in_progress', created_at: '2026-11-01T00:00:00Z' },
      { id: 'done', status: 'completed', created_at: '2026-11-12T00:00:00Z' },
      { id: 'new', status: 'pending', created_at: '2026-11-10T00:00:00Z' },
    ])).toBe('new');
    expect(openTaskId([{ id: 'done', status: 'completed', created_at: '2026-11-12T00:00:00Z' }])).toBeNull();
  });

  it('makes one chip per checklist category in checklist order', () => {
    const cats = [{ id: '1', code: 'rc', name: 'RC book' }, { id: '2', code: 'dl', name: 'Licence' }, { id: '3', code: 'old', name: 'Old', is_active: false }];
    expect(chipsFrom([{ category_id: '2', position: 2 }, { category_id: '1', position: 1 }, { category_id: '1', position: 3 }, { category_id: null, position: 4 }, { category_id: '3', position: 5 }], cats))
      .toEqual([{ code: 'rc', name: 'RC book' }, { code: 'dl', name: 'Licence' }]);
  });

  it('hides attach on a completed case and before the first load', () => {
    expect(attachState({ taskId: 't', chips: [], loadedAt: '' }, NO_TASK_TEXT)).toEqual({ kind: 'ready', taskId: 't' });
    expect(attachState({ taskId: null, chips: [], loadedAt: '' }, NO_TASK_TEXT)).toEqual({ kind: 'completed', text: NO_TASK_TEXT });
    expect(attachState(null, NO_TASK_TEXT)).toEqual({ kind: 'unknown', text: UNKNOWN_TEXT });
  });
});

describe('draft store', () => {
  it('keeps one draft per case, de-duplicates files, keeps the chip after Send', () => {
    const d = new DraftStore();
    let calls = 0;
    const off = d.subscribe(() => calls++);
    d.update('c', { text: 'hi', categoryCode: 'rc' });
    d.addFiles('c', [file('a'), file('a'), file('b')]);
    expect(d.get('c').files.map((f) => f.sha256[0])).toEqual(['a', 'b']);
    expect(d.removeFile('c', file('a').sha256)?.sha256).toBe(file('a').sha256);
    expect(d.get('other')).toEqual({ text: '', categoryCode: null, files: [] });
    d.sent('c', true);
    expect(d.get('c')).toMatchObject({ text: '', categoryCode: 'rc', files: [{ sha256: file('b').sha256 }] });
    d.sent('c');
    expect(d.get('c').files).toEqual([]);
    off();
    const before = calls;
    d.update('c', { text: 'x' });
    expect(calls).toBe(before);
  });
});
