// D55 Aadhaar masking at report time: number detection in OCR blocks, boxes over the first 8 digits, scaling to the
// embedded image, the per-photo decision and the edge function path. Fictional numbers in the Aadhaar format only.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Box, charWeight, countNumbers, createAadhaarMasker, findAadhaar, findNumbers, isIdCategory, maskPhoto,
  MASK_WARNING_PREFIX, type OcrBlockLike, ocrByEvidence, type OcrRowLike, ocrSpace, PAD_CHARS, PAD_Y, type Painter,
  readBlocks, rowsOf, scaleBoxes,
} from '../../../supabase/functions/_shared/report/aadhaar.ts';
import type { ReportImage } from '../../../supabase/functions/_shared/report/bind.ts';
import { CASE, fakeGateway, photo, post, prepared } from './report-generate-helpers.ts';

const blk = (text: string, x: number, y: number, w: number, h: number): OcrBlockLike => ({ text, bbox: [x, y, w, h] });
const weight = (s: string) => s.split('').reduce((a, c) => a + charWeight(c), 0);
const close = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/** The box findAadhaar should give for characters [s, e) of a block. */
function expected(b: OcrBlockLike, s: number, e: number): Box {
  const [x, y, w, h] = b.bbox;
  const unit = w / weight(b.text);
  const x0 = x + weight(b.text.slice(0, s)) * unit - PAD_CHARS * unit;
  const x1 = x + weight(b.text.slice(0, e)) * unit + PAD_CHARS * unit;
  return { x: x0, y: y - h * PAD_Y, w: x1 - x0, h: h * (1 + 2 * PAD_Y) };
}
function sameBox(a: Box, b: Box) {
  close(a.x, b.x); close(a.y, b.y); close(a.w, b.w); close(a.h, b.h);
}

describe('findNumbers (one line of text)', () => {
  it('plain, grouped with spaces, hyphens, dots and double spaces', () => {
    for (const t of ['234567890123', '2345 6789 0123', '2345-6789-0123', '2345.6789.0123', '2345  6789  0123', '2345 - 6789 0123']) {
      const [n, ...rest] = findNumbers(t);
      assert.equal(rest.length, 0, t);
      assert.equal(n.start, 0);
      assert.equal(n.last4, '0123');
      assert.equal(t.slice(n.start, n.end8).replace(/\D/g, ''), '23456789', t);
    }
  });

  it('inside a longer line', () => {
    const t = 'Aadhaar No.: 9876 5432 1098 (enrolled)';
    const [n] = findNumbers(t);
    assert.equal(t.slice(n.start, n.end), '9876 5432 1098');
  });

  it('no match: first digit 0 or 1, too short, part of a longer digit run, letters', () => {
    for (const t of ['0123 4567 8901', '1234 5678 9012', '2345 6789 012', '22345 6789 0123', '2345 6789 01234',
      'MH12AB1234 policy 2345', 'Policy no. 3001/2345/6789', '2345678901234']) {
      assert.deepEqual(findNumbers(t), [], t);
    }
  });

  it('a 16-digit VID: its first 8 digits are covered too', () => {
    const [n] = findNumbers('VID : 9123 4567 8901 2345');
    assert.equal(n.last4, '8901');
  });

  it('Devanagari digits', () => {
    const t = 'आधार संख्या २३४५ ६७८९ ०१२३';
    const [n] = findNumbers(t);
    assert.equal(t.slice(n.start, n.end), '२३४५ ६७८९ ०१२३');
    assert.equal(n.last4, '0123');
  });

  it('common OCR confusions inside a number (at most two)', () => {
    assert.equal(findNumbers('2345 67B9 O123').length, 1);
    assert.deepEqual(findNumbers('2SBS 67B9 O1Z3'), []);
    assert.deepEqual(findNumbers('No 2345'), []);
  });

  it('text masked on the phone before D55', () => {
    const [n] = findNumbers('Aadhaar XXXX XXXX 0123');
    assert.equal(n.premasked, true);
    assert.equal(n.last4, '0123');
  });

  it('countNumbers reads every line', () => {
    assert.equal(countNumbers('GOVERNMENT OF INDIA\n2345 6789 0123\nVID 3456 7890 1234 5678'), 2);
    assert.equal(countNumbers(null), 0);
  });
});

describe('findAadhaar (blocks)', () => {
  it('a block holding only the number: box over the first 8 digits, padded', () => {
    const b = blk('2345 6789 0123', 400, 600, 700, 60);
    const [hit] = findAadhaar([b]);
    assert.equal(hit.boxes.length, 1);
    sameBox(hit.boxes[0], expected(b, 0, 9));
    // the left edge reaches one digit before the block, the right edge stops before the last group's second digit
    const unit = 700 / weight(b.text);
    assert.ok(hit.boxes[0].x < 400);
    assert.ok(hit.boxes[0].x + hit.boxes[0].w < 400 + weight('2345 6789 01') * unit);
  });

  it('plain 12 digits', () => {
    const b = blk('234567890123', 0, 0, 600, 40);
    sameBox(findAadhaar([b])[0].boxes[0], expected(b, 0, 8));
  });

  it('embedded in a longer line: the x-range starts after the label', () => {
    const b = blk('Aadhaar No.: 2345 6789 0123', 100, 300, 1000, 50);
    const [hit] = findAadhaar([b]);
    sameBox(hit.boxes[0], expected(b, 13, 22));
    assert.ok(hit.boxes[0].x > 100 + 300);
  });

  it('split over two blocks of one row: one box per block', () => {
    const a = blk('2345', 100, 500, 200, 50);
    const b = blk('6789 0123', 330, 505, 450, 50);
    const [hit, ...rest] = findAadhaar([b, a]);
    assert.equal(rest.length, 0);
    assert.equal(hit.boxes.length, 2);
    sameBox(hit.boxes[0], expected(a, 0, 4));
    sameBox(hit.boxes[1], expected(b, 0, 4));
  });

  it('blocks far apart on a row, or on different rows, are not joined', () => {
    assert.deepEqual(findAadhaar([blk('2345 6789', 0, 100, 400, 40), blk('0123', 1500, 100, 180, 40)]), []);
    assert.deepEqual(findAadhaar([blk('2345 6789', 0, 100, 400, 40), blk('0123', 420, 200, 180, 40)]), []);
  });

  it('two numbers on one photo', () => {
    const hits = findAadhaar([blk('2345 6789 0123', 0, 100, 600, 40), blk('Spouse: 3456 7890 1234', 0, 400, 900, 40)]);
    assert.equal(hits.length, 2);
  });

  it('no number: nothing', () => {
    assert.deepEqual(findAadhaar([blk('GOVERNMENT OF INDIA', 0, 0, 800, 40), blk('DOB: 01/01/1990', 0, 60, 500, 40)]), []);
  });

  it('readBlocks drops malformed entries; rowsOf orders rows and blocks', () => {
    const v = [{ text: 'ok', bbox: [1, 2, 3, 4] }, { text: '', bbox: [1, 2, 3, 4] }, { text: 'x', bbox: [1, 2, 3] },
      { text: 'y', bbox: [1, 2, -3, 4] }, { text: 'z', bbox: ['1', 2, 3, 4] }, null, 'nope'];
    assert.deepEqual(readBlocks(v), [{ text: 'ok', bbox: [1, 2, 3, 4] }]);
    assert.deepEqual(readBlocks({}), []);
    const rows = rowsOf([blk('b', 300, 102, 50, 40), blk('c', 0, 300, 50, 40), blk('a', 0, 100, 50, 40)]);
    assert.deepEqual(rows.map((r) => r.map((b) => b.text)), [['a', 'b'], ['c']]);
  });
});

describe('scaling', () => {
  it('scales to the embedded image, rounds outwards and clips', () => {
    const r = scaleBoxes([{ x: -10, y: 100.5, w: 410, h: 50 }, { x: 1590, y: 1190, w: 50, h: 50 }],
      { width: 1600, height: 1200 }, { width: 384, height: 288 });
    assert.deepEqual(r, [{ x: 0, y: 24, w: 96, h: 13 }, { x: 381, y: 285, w: 3, h: 3 }]);
  });

  it('refuses a different aspect ratio (e.g. OCR of a rotated picture)', () => {
    assert.equal(scaleBoxes([{ x: 0, y: 0, w: 10, h: 10 }], { width: 1200, height: 1600 }, { width: 1600, height: 1200 }), null);
    assert.notEqual(scaleBoxes([{ x: 0, y: 0, w: 10, h: 10 }], { width: 1600, height: 1200 }, { width: 1599, height: 1200 }), null);
  });

  it('ocrSpace: device copies by recorded size, the original only when it is the embedded image', () => {
    const derivs = [{ width: 1600, pixel_width: 1600, pixel_height: 900 }, { width: 384, pixel_width: 384, pixel_height: 216 }];
    const img = { width: 384, height: 216 };
    const row = (source_width: number | null): OcrRowLike => ({ evidence_id: 'e', source_width });
    assert.deepEqual(ocrSpace(row(1600), derivs, 'copy384', img), { width: 1600, height: 900 });
    assert.deepEqual(ocrSpace(row(1600), [], 'copy1600', { width: 1600, height: 900 }), { width: 1600, height: 900 });
    // copy not recorded, original embedded: the copy is the original scaled to a 1600 px long edge
    assert.deepEqual(ocrSpace(row(1600), [], 'original', { width: 4000, height: 3000 }), { width: 1600, height: 1200 });
    assert.deepEqual(ocrSpace(row(1600), [], 'original', { width: 1200, height: 900 }), { width: 1200, height: 900 });
    assert.deepEqual(ocrSpace(row(null), derivs, 'original', { width: 800, height: 600 }), { width: 800, height: 600 });
    assert.equal(ocrSpace(row(null), derivs, 'copy1600', { width: 1600, height: 900 }), null);
    assert.equal(ocrSpace(row(640), derivs, 'copy1600', { width: 1600, height: 900 }), null);
  });
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const IMG: ReportImage = { bytes: JPEG, mime: 'image/jpeg', width: 1600, height: 1200 };
const LABEL = 'Photo "Aadhaar front" (Insured details)';
const rowWith = (over: Partial<OcrRowLike> = {}): OcrRowLike => ({
  evidence_id: 'E1', page_no: 1, engine: 'mlkit_device', source_width: 1600, is_current: true,
  text: '2345 6789 0123', blocks: [{ text: '2345 6789 0123', bbox: [400, 600, 700, 60], conf: 0.9, line: 0 }], ...over,
});
const painter = (seen: Box[][]): Painter => async (image, rectsFor) => {
  const rects = rectsFor({ width: image.width!, height: image.height! });
  seen.push(rects);
  return rects.length ? { ...image, bytes: new Uint8Array([0xff, 0xd8, 0xff, 9]) } : image;
};

describe('maskPhoto (one photo)', () => {
  it('masks a number found in the device OCR', async () => {
    const seen: Box[][] = [];
    const r = await maskPhoto(IMG, { rows: [rowWith()], kind: 'copy1600', label: LABEL }, painter(seen));
    assert.equal(r.masked, 1);
    assert.deepEqual(r.warnings, []);
    assert.notEqual(r.image, IMG);
    assert.equal(seen[0].length, 1);
  });

  it('nothing found on an ordinary photo: no pixel work, no warning', async () => {
    const seen: Box[][] = [];
    const r = await maskPhoto(IMG, { rows: [rowWith({ text: 'MH 12 AB 1234', blocks: [] })], kind: 'copy1600', label: LABEL }, painter(seen));
    assert.equal(r.image, IMG);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(seen, []);
  });

  it('ID photo: no OCR, OCR without a number, OCR not loaded', async () => {
    const base = { categoryCode: 'id_document', kind: 'copy1600' as const, label: LABEL };
    const none = await maskPhoto(IMG, { ...base, rows: [] }, painter([]));
    assert.equal(none.image, IMG);
    assert.match(none.warnings[0], /^Aadhaar masking: ID photo "Aadhaar front" \(Insured details\) could not be masked automatically: no text has been read from it yet\./);
    const noNumber = await maskPhoto(IMG, { ...base, rows: [rowWith({ text: 'PAN 1234', blocks: [] })] }, painter([]));
    assert.match(noNumber.warnings[0], /no Aadhaar number was found/);
    const notLoaded = await maskPhoto(IMG, { ...base, rows: null }, painter([]));
    assert.match(notLoaded.warnings[0], /could not be loaded/);
    assert.ok(isIdCategory('id_document') && isIdCategory('aadhaar_card') && !isIdCategory('vehicle_photo') && !isIdCategory(null));
  });

  it('a number in the text that no block places: placed as it is, with a warning', async () => {
    const r = await maskPhoto(IMG, { rows: [rowWith({ blocks: [] })], kind: 'copy1600', label: LABEL }, painter([]));
    assert.equal(r.image, IMG);
    assert.match(r.warnings[0], /^Aadhaar masking: Photo .* the number read from it could not be placed on the image/);
  });

  it('several readings of one file are combined (device row maps, server row of the original does not)', async () => {
    const seen: Box[][] = [];
    const server = rowWith({ engine: 'paddleocr', source_width: null, is_current: true });
    const device = rowWith({ is_current: false });
    const r = await maskPhoto(IMG, { rows: [server, device], kind: 'copy1600', label: LABEL }, painter(seen));
    assert.equal(r.masked, 1);
    assert.deepEqual(r.warnings, []);
  });

  it('no painter (edge function): the photo is not placed', async () => {
    const r = await maskPhoto(IMG, { rows: [rowWith()], kind: 'copy1600', label: LABEL }, null);
    assert.equal(r.image, null);
    assert.ok(r.warnings[0].startsWith(MASK_WARNING_PREFIX));
  });

  it('createAadhaarMasker finds the rows by evidence id, case-insensitively', async () => {
    const seen: Box[][] = [];
    const m = createAadhaarMasker(ocrByEvidence([rowWith({ evidence_id: 'ABC' })]), painter(seen));
    const p = { ...photo(1), evidence_id: 'abc' };
    const r = await m(p, { store: 'r2', path: 'x', size: 1, kind: 'copy1600', width: 1600, height: 1200 }, IMG, LABEL);
    assert.equal(seen.length, 1);
    assert.deepEqual(r.warnings, []);
  });
});

describe('report-generate edge function (no canvas)', () => {
  it('a photo showing a number becomes a placeholder and is not recorded as placed', async () => {
    const p1 = photo(1);
    const { gw, calls } = fakeGateway({
      prepared: prepared({ photos: [p1, photo(2)] }),
      ocr: [rowWith({ evidence_id: p1.evidence_id })],
    });
    const r = await post(gw, { case_id: CASE });
    assert.equal(r.status, 200);
    const warnings = r.body.warnings as string[];
    assert.equal(warnings.filter((w) => w.startsWith(MASK_WARNING_PREFIX)).length, 1);
    const create = calls.find((c) => c.fn === 'createVersion')!.args[0] as { p_photos: { evidence_id: string }[] };
    assert.deepEqual(create.p_photos.map((x) => x.evidence_id), [photo(2).evidence_id]);
    assert.deepEqual(calls.find((c) => c.fn === 'loadOcr')!.args[0], [p1.evidence_id, photo(2).evidence_id]);
  });

  it('OCR not readable: one warning, photos still placed', async () => {
    const { gw } = fakeGateway({ ocr: null });
    const r = await post(gw, { case_id: CASE });
    assert.equal(r.status, 200);
    assert.equal((r.body.warnings as string[]).filter((w) => w.startsWith(MASK_WARNING_PREFIX)).length, 1);
    assert.equal(r.body.photos, 2);
  });
});
