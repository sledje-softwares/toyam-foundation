// Device OCR logic (gap 35; D55: text kept as read, mask.ts unused here): Aadhaar regex helper, block mapping / merging, description, the read step.
import { describe, expect, it } from 'vitest';
import type { OutboxFile } from '../outbox/types';
import { mergeReadings, overlap, type NativeLine, type NativeOcrResult } from './blocks';
import { DESCRIPTION_MAX, describePhoto, guessKind, meaningful } from './describe';
import { maskAadhaar } from './mask';
import { OCR_MAX_BLOCKS, type OcrEngine, readPhoto } from './read';

const line = (text: string, left: number, top: number, width = 200, height = 30, confidence: number | null = 0.9): NativeLine => ({
  text, frame: { left, top, width, height }, confidence,
});
const result = (latin: NativeLine[], devanagari: NativeLine[] = [], w = 1600, h = 1200): NativeOcrResult => ({
  width: w, height: h, latin: { blocks: [{ lines: latin }] }, devanagari: { blocks: [{ lines: devanagari }] },
});

describe('maskAadhaar', () => {
  it('masks 12-digit numbers starting 2-9, plain or grouped 4-4-4, to the last 4 digits', () => {
    expect(maskAadhaar('2345 6789 0123')).toBe('XXXX XXXX 0123');
    expect(maskAadhaar('Aadhaar: 234567890123.')).toBe('Aadhaar: XXXX XXXX 0123.');
    expect(maskAadhaar('UID 2345-6789-0123 and 9876 5432 1098')).toBe('UID XXXX XXXX 0123 and XXXX XXXX 1098');
    expect(maskAadhaar('2345  6789  0123')).toBe('XXXX XXXX 0123');
    expect(maskAadhaar('आधार 4567 8901 2345')).toBe('आधार XXXX XXXX 2345');
  });

  it('keeps other numbers as read (report fields)', () => {
    expect(maskAadhaar('MH 12 AB 3456')).toBe('MH 12 AB 3456');
    expect(maskAadhaar('DL MH1420110012345')).toBe('DL MH1420110012345'); // 13 digits after letters
    expect(maskAadhaar('1234 5678 9012')).toBe('1234 5678 9012'); // starts with 1: not an Aadhaar
    expect(maskAadhaar('0234 5678 9012')).toBe('0234 5678 9012');
    expect(maskAadhaar('Policy 98765432101234')).toBe('Policy 98765432101234'); // 14 digits
    expect(maskAadhaar('Chassis MA3FJEB1S00123456')).toBe('Chassis MA3FJEB1S00123456');
    expect(maskAadhaar('23456789012')).toBe('23456789012'); // 11 digits
  });

  it('masks two numbers next to each other and is idempotent', () => {
    const once = maskAadhaar('234567890123 345678901234');
    expect(once).toBe('XXXX XXXX 0123 XXXX XXXX 1234');
    expect(maskAadhaar(once)).toBe(once);
  });
});

describe('mergeReadings (block mapping)', () => {
  it('one block per line in the documented shape, reading order, mean confidence by text length', () => {
    const r = mergeReadings(result([line('Second line', 10, 100), line('First', 10, 10, 100, 30, 0.5)]));
    expect(r.blocks).toEqual([
      { text: 'First', bbox: [10, 10, 100, 30], conf: 0.5, line: 0 },
      { text: 'Second line', bbox: [10, 100, 200, 30], conf: 0.9, line: 1 },
    ]);
    expect(r.text).toBe('First\nSecond line');
    expect(r.mean_confidence).toBeCloseTo((0.5 * 5 + 0.9 * 11) / 16, 3);
    expect(r.lang).toBe('latin');
  });

  it('left to right within a row; frames clamped to the image; empty lines dropped', () => {
    const r = mergeReadings(result([line('right', 400, 12), line('left', -5, 10, 100, 30), line('   ', 0, 300)]));
    expect(r.blocks.map((b) => b.text)).toEqual(['left', 'right']);
    expect(r.blocks[0]!.bbox).toEqual([0, 10, 95, 30]);
  });

  it('Devanagari lines replace the Latin noise they overlap; Latin lines elsewhere stay', () => {
    const r = mergeReadings(result(
      [line('MH 12 AB 3456', 10, 10), line('xxl ~ ;', 10, 100)],
      [line('रजिस्ट्रेशन प्रमाणपत्र', 12, 102), line('MH 12 AB 3456', 10, 10)],
    ));
    expect(r.blocks.map((b) => b.text)).toEqual(['MH 12 AB 3456', 'रजिस्ट्रेशन प्रमाणपत्र']);
    expect(r.lang).toBe('latin+devanagari');
  });

  it('keeps Aadhaar-like numbers as read in the text and every block (D55)', () => {
    const r = mergeReadings(result([line('2345 6789 0123', 10, 10)]));
    expect(r.text).toBe('2345 6789 0123');
    expect(r.blocks[0]!.text).toBe('2345 6789 0123');
  });

  it('no text: empty text, no blocks, null confidence and language; missing confidences ignored', () => {
    const none = mergeReadings({ width: 1600, height: 1200, latin: { blocks: [] } });
    expect(none).toMatchObject({ text: '', blocks: [], mean_confidence: null, lang: null, coverage: 0 });
    expect(mergeReadings(result([line('abc', 0, 0, 10, 10, null)])).mean_confidence).toBeNull();
  });

  it('overlap is relative to the smaller box', () => {
    expect(overlap([0, 0, 10, 10], [0, 0, 100, 100])).toBe(1);
    expect(overlap([0, 0, 10, 10], [20, 20, 10, 10])).toBe(0);
  });
});

describe('describePhoto', () => {
  it('uses the operator tag and the first three meaningful lines', () => {
    expect(describePhoto({ categoryName: 'Registration certificate', lines: ['MH 12 AB 3456', '~~', 'Owner R KUMAR', 'Valid 2030', 'Fuel PETROL'], coverage: 0.3 }))
      .toBe('Registration certificate; text read from the 1600 px copy: MH 12 AB 3456 · Owner R KUMAR · Valid 2030');
  });

  it('guesses Photo / Document from text density without a tag', () => {
    expect(describePhoto({ categoryName: null, lines: ['MH12AB3456'], coverage: 0.01 })).toBe('Photo; text read from the 1600 px copy: MH12AB3456');
    expect(describePhoto({ categoryName: null, lines: ['Tax invoice'], coverage: 0.2 })).toMatch(/^Document; /);
    expect(guessKind(Array(8).fill('line of some text'), 0.05)).toBe('Document');
    expect(guessKind(['a'], 0)).toBe('Photo');
  });

  it('says so when no text was read', () => {
    expect(describePhoto({ categoryName: 'Front view', lines: [], coverage: 0 })).toBe('Front view; no text read');
    expect(describePhoto({ categoryName: null, lines: ['-', '..'], coverage: 0 })).toBe('Photo; no text read');
  });

  it('at most 200 characters, cut at a word', () => {
    const d = describePhoto({ categoryName: 'Claim form', lines: [Array(60).fill('word').join(' '), 'second'], coverage: 0.5 });
    expect(d.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(d.endsWith('…')).toBe(true);
  });

  it('keeps Aadhaar-like numbers as read (D55) and drops duplicates / noise', () => {
    expect(describePhoto({ categoryName: 'ID card', lines: ['2345 6789 0123', '2345 6789 0123', '|||'], coverage: 0.1 }))
      .toBe('ID card; text read from the 1600 px copy: 2345 6789 0123');
    expect(meaningful('ab')).toBe(false);
    expect(meaningful('रजिस्ट्रेशन')).toBe(true);
  });
});

describe('readPhoto (the read step)', () => {
  const file = (over: Partial<OutboxFile> = {}): OutboxFile => ({
    id: 'f1', local_path: 'file:///o/f1.jpg', sha256: 'a'.repeat(64), size_bytes: 1, mime_type: 'image/jpeg', ext: 'jpg',
    evidence_type: 'photo', device_captured_at: '2026-11-19T10:00:00Z', gps: null, capture_source: 'camera',
    original_filename: null, checklist_item_id: null, storage_path: null, bytes_sent: 0,
    copies: [
      { width: 1600, local_path: 'file:///o/copy-f1-w1600.jpg', sha256: 'b'.repeat(64), size_bytes: 1, pixel_width: 1600, pixel_height: 1200, storage_path: null, attempts: 0 },
      { width: 384, local_path: 'file:///o/copy-f1-w384.jpg', sha256: 'c'.repeat(64), size_bytes: 1, pixel_width: 384, pixel_height: 288, storage_path: null, attempts: 0 },
    ],
    ...over,
  });
  const engine = (r: NativeOcrResult | Error, seen: string[] = []): OcrEngine => ({
    version: 'mlkit-test',
    recognize: async (uri) => {
      seen.push(uri);
      if (r instanceof Error) throw r;
      return r;
    },
  });

  it('reads the 1600 px copy and returns the result as read with its description', async () => {
    const seen: string[] = [];
    const o = await readPhoto(engine(result([line('Aadhaar 2345 6789 0123', 10, 10)]), seen), file(), 'ID card');
    expect(seen).toEqual(['file:///o/copy-f1-w1600.jpg']);
    expect(o).toMatchObject({
      engine_version: 'mlkit-test', lang: 'latin', text: 'Aadhaar 2345 6789 0123', source_width: 1600, attempts: 0,
      description: 'ID card; text read from the 1600 px copy: Aadhaar 2345 6789 0123',
    });
  });

  it('nothing for videos, photos without a 1600 px copy, or a failing engine', async () => {
    expect(await readPhoto(engine(result([])), file({ evidence_type: 'video' }), null)).toBeNull();
    expect(await readPhoto(engine(result([])), file({ copies: [] }), null)).toBeNull();
    expect(await readPhoto(engine(new Error('decode failed')), file(), null)).toBeNull();
  });

  it('keeps within the server limits', async () => {
    const many = Array.from({ length: OCR_MAX_BLOCKS + 10 }, (_, i) => line(`line ${i}`, 0, i * 40));
    const o = await readPhoto(engine(result(many, [], 1600, 100_000)), file(), null);
    expect(o!.blocks).toHaveLength(OCR_MAX_BLOCKS);
  });
});
