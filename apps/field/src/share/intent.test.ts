// Share target (5.6): intent payload → inbox → draft mapping.
import { describe, expect, it } from 'vitest';
import { MB } from '../capture/limits';
import { fileCountLine } from '../capture/item';
import type { CaseRow } from '../lib/cases';
import {
  inboxBanner, inboxName, MAX_SHARED_FILES, mergeInbox, NO_OPEN_CASE, parseSharePayload, screenShared, shareCaseChoices,
  shareHeading, toPicked, type InboxFile, type SharedSource,
} from './intent';

const android = (files: Record<string, unknown>[]) => ({ files, type: 'file' });
const photo = { contentUri: 'content://media/external/images/media/12', filePath: '/storage/emulated/0/DCIM/Camera/IMG_1.jpg', fileName: 'IMG_1.jpg', fileSize: '2048000', mimeType: 'image/jpeg', width: '4000', height: '3000' };

describe('parseSharePayload', () => {
  it('maps ACTION_SEND_MULTIPLE files, content URI first, numbers parsed', () => {
    const r = parseSharePayload(android([photo, { contentUri: 'content://x/2', fileName: 'claim.pdf', fileSize: '1000', mimeType: 'application/pdf' }]));
    expect(r.files).toEqual([
      { uri: 'content://media/external/images/media/12', name: 'IMG_1.jpg', mime: 'image/jpeg', size: 2048000, width: 4000, height: 3000 },
      { uri: 'content://x/2', name: 'claim.pdf', mime: 'application/pdf', size: 1000, width: null, height: null },
    ]);
    expect(r.text).toBeNull();
  });

  it('ACTION_SEND: skips the stray non-file entry the module adds to the array', () => {
    const r = parseSharePayload({ files: [photo, { first: 'type', second: 'file' }, ['type', 'file']] });
    expect(r.files).toHaveLength(1);
  });

  it('falls back to the file path; guesses the type from the name; drops files without any URI', () => {
    const r = parseSharePayload(android([{ filePath: '/sdcard/a.JPG', fileName: 'a.JPG', mimeType: 'application/octet-stream' }, { fileName: 'lost.jpg' }]));
    expect(r.files).toEqual([{ uri: 'file:///sdcard/a.JPG', name: 'a.JPG', mime: 'image/jpeg', size: null, width: null, height: null }]);
  });

  it('text shares carry no files', () => {
    expect(parseSharePayload({ type: 'text', text: 'https://example.com' })).toEqual({ files: [], text: 'https://example.com' });
    expect(parseSharePayload(null)).toEqual({ files: [], text: null });
  });
});

describe('screenShared (same caps as evidence-upload)', () => {
  const f = (o: Partial<SharedSource>): SharedSource => ({ uri: 'content://x', name: 'x', mime: 'image/jpeg', size: 1000, width: null, height: null, ...o });

  it('accepts photos, videos, audio and PDFs within the caps', () => {
    const { accepted, rejected } = screenShared([f({}), f({ mime: 'video/mp4', size: 200 * MB }), f({ mime: 'audio/mpeg' }), f({ mime: 'application/pdf' })]);
    expect(accepted).toHaveLength(4);
    expect(rejected).toEqual([]);
  });

  it('refuses unsupported types and files over the cap with the composer wording', () => {
    const { accepted, rejected } = screenShared([
      f({ name: 'notes.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      f({ name: 'big.jpg', size: 21 * MB }),
      f({ name: 'long.mp4', mime: 'video/mp4', size: 301 * MB }),
    ]);
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.name)).toEqual(['notes.docx', 'big.jpg', 'long.mp4']);
    expect(rejected[1]!.message).toBe('This file is larger than 20 MB and cannot be sent.');
  });

  it('unknown size is checked after the copy; more than the maximum is refused', () => {
    expect(screenShared([f({ size: null })]).accepted).toHaveLength(1);
    const many = screenShared(Array.from({ length: MAX_SHARED_FILES + 2 }, () => f({})));
    expect(many.accepted).toHaveLength(MAX_SHARED_FILES);
    expect(many.rejected).toHaveLength(2);
  });
});

describe('inbox and draft', () => {
  const file = (n: number): InboxFile => ({ local_path: `file:///doc/share-inbox/${n}.jpg`, name: `${n}.jpg`, mime: 'image/jpeg', size: MB, width: 4000, height: 3000 });

  it('a second share before a case is chosen is appended', () => {
    const a = mergeInbox(null, { files: [file(1)], rejected: [] }, '2026-11-19T10:00:00Z');
    const b = mergeInbox(a, { files: [file(1), file(2)], rejected: [{ name: 'x', message: 'm' }] }, '2026-11-19T11:00:00Z');
    expect(b.received_at).toBe('2026-11-19T10:00:00Z');
    expect(b.files.map((f) => f.name)).toEqual(['1.jpg', '2.jpg']);
    expect(b.rejected).toHaveLength(1);
  });

  it('inbox copy → a gallery-like pick (prepared with capture_source share)', () => {
    expect(toPicked(file(1))).toEqual({ uri: 'file:///doc/share-inbox/1.jpg', mimeType: 'image/jpeg', name: '1.jpg', size: MB, width: 4000, height: 3000, exif: null, lastModified: null });
    expect(inboxName('ABC-1', 'application/pdf')).toBe('abc-1.pdf');
  });

  it('heading, banner and the composer count line', () => {
    expect(shareHeading({ received_at: 'x', files: [file(1), file(2)], rejected: [] })).toBe('2 files to send · 2.0 MB');
    expect(inboxBanner({ received_at: 'x', files: [file(1)], rejected: [] })).toBe('1 shared file waiting — choose a case');
    expect(inboxBanner(null)).toBeNull();
    expect(fileCountLine(13)).toBe('13 files · sent as 1 message');
    expect(fileCountLine(31)).toBe('31 files · sent as 2 messages');
  });
});

describe('case choice', () => {
  const row = (id: string, list: string, at: string | null): CaseRow => ({
    case_id: id, case_ref: id, insurer_name: 'I', claim_type: 'motor', title: null, list, last_message_at: at, last_message_preview: null, unread_count: 0,
  });

  it('only open cases, newest activity first', () => {
    const r = shareCaseChoices([row('a', 'open', '2026-11-18'), row('b', 'completed', '2026-11-19'), row('c', 'open', '2026-11-19'), row('d', 'open', null)]);
    expect(r.map((x) => x.case_id)).toEqual(['c', 'a', 'd']);
  });

  it('no open case: nothing to choose, the clear message', () => {
    expect(shareCaseChoices([row('b', 'completed', null)])).toEqual([]);
    expect(NO_OPEN_CASE.body).toMatch(/no open case/);
  });
});
