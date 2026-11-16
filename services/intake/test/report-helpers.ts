// Shared fixtures for the report-*.test.ts suites (fictional data only).
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { readYaml, resolveTemplateLayout, type TemplateYaml } from '../src/template-config.ts';
import type { ReportData, ReportPhoto } from '../../../supabase/functions/_shared/report/bind.ts';
import type { ReportLayout } from '../../../supabase/functions/_shared/report/spec.ts';

export const FIXTURES = new URL('./fixtures/report/', import.meta.url).pathname;

export const photoA = () => new Uint8Array(readFileSync(`${FIXTURES}photo-a.jpg`));
export const photoB = () => new Uint8Array(readFileSync(`${FIXTURES}photo-b.jpg`));
export const letterhead = () => new Uint8Array(readFileSync(`${FIXTURES}letterhead.png`));

export function exampleTemplate(): TemplateYaml {
  return readYaml<TemplateYaml>(`${FIXTURES}example-template.yaml`);
}

/** The example layout with its asset files embedded (as the loader stores it). */
export function exampleLayout(): ReportLayout {
  const { config, errors } = resolveTemplateLayout(exampleTemplate(), `${FIXTURES}example-template.yaml`);
  if (errors.length) throw new Error(errors.join('\n'));
  return config.report_layout as ReportLayout;
}

export function exampleData(opts: { photos?: boolean } = {}): ReportData {
  const raw = JSON.parse(readFileSync(`${FIXTURES}example-data.json`, 'utf8')) as ReportData & { _note?: string };
  delete raw._note;
  const a = photoA();
  const b = photoB();
  const garage: ReportPhoto[] = [
    { evidence_id: 'ev-1', caption: 'Front view', image: { bytes: a, mime: 'image/jpeg' } },
    { evidence_id: 'ev-2', caption: 'Rear view', image: { bytes: b, mime: 'image/jpeg', width: 120, height: 160 } },
    { evidence_id: 'ev-3', caption: 'Odometer', image: null },
  ];
  return { ...raw, photos: opts.photos === false ? {} : { garage }, assets: { seal: { bytes: b, mime: 'image/jpeg' } } };
}

/** Minimal zip reader (central directory; stored and deflated entries). */
export function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no end of central directory');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const body = zip.subarray(start, start + csize);
    out.set(name, method === 0 ? body : new Uint8Array(inflateRawSync(body)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
