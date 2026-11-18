// Local dev photos (scripts/dev-photos.ts): deterministic PNGs and file names the filename_rule labeller recognises.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';
import { encodePng, photoName, PHOTO_KINDS, renderDevPhoto } from '../scripts/dev-photos-lib.ts';
import { readYaml, TEMPLATES_DIR } from '../src/template-config.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('dev photos', () => {
  it('encodes a valid 8-bit RGB PNG', () => {
    const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 0, 0, 255]));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset);
    assert.equal(dv.getUint32(16), 2); // width
    assert.equal(dv.getUint32(20), 1); // height
    const idatLen = dv.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    assert.deepEqual([...raw], [0, 255, 0, 0, 0, 0, 255]); // filter byte + pixels
  });
  it('is deterministic per index and differs between indexes', () => {
    const a = renderDevPhoto(3, 'INV-2026-000008', 160, 120);
    const b = renderDevPhoto(3, 'INV-2026-000008', 160, 120);
    const c = renderDevPhoto(4, 'INV-2026-000008', 160, 120);
    assert.equal(sha(a.png), sha(b.png));
    assert.notEqual(sha(a.png), sha(c.png));
  });
  it('names files after categories whose filename patterns match them', () => {
    const cats = readYaml<{ code: string; filename_patterns?: string[] }[]>(`${TEMPLATES_DIR}_categories.yaml`);
    for (let i = 0; i < PHOTO_KINDS.length * 2; i++) {
      const p = photoName(i);
      const base = p.fileName.replace(/\.png$/, '').replace(/\(\s*\d+\s*\)/g, ' ').trim().toLowerCase();
      const hits = cats.filter((c) => (c.filename_patterns ?? []).some((re) => new RegExp(re, 'i').test(base))).map((c) => c.code);
      assert.deepEqual(hits, [p.category], p.fileName);
    }
    assert.equal(photoName(8).fileName, 'Front View(2).png');
  });
});
