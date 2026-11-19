// Device OCR of one photo (docs/11 "Device OCR and description"). Pure: the ML Kit call is injected
// (`OcrEngine`; native adapter in ./native.ts), so this runs under vitest.
//
// Reads the 1600 px copy (D51) — never the original (smaller decode, the same pixels the report prints),
// never videos / audio / PDFs (a PDF's text layer is read on the server). Best effort: any failure
// returns null and the file is sent as usual.
import type { OutboxCopy, OutboxFile, OutboxOcr } from '../outbox/types';
import { mergeReadings, type NativeOcrResult } from './blocks';
import { describePhoto } from './describe';

/** Same limits as record_device_ocr (20261119600000). */
export const OCR_MAX_TEXT = 20_000;
export const OCR_MAX_BLOCKS = 2_000;
export const OCR_MAX_BLOCK_TEXT = 2_000;
export const OCR_SOURCE_WIDTH = 1600;

export interface OcrEngine {
  /** e.g. "mlkit-text 16.0.1 + devanagari 16.0.1"; recorded with every result. */
  readonly version: string;
  recognize(uri: string): Promise<NativeOcrResult>;
}

/** The copy OCR reads: the 1600 px one, while its file is still on the phone. */
export const ocrSource = (f: Pick<OutboxFile, 'evidence_type' | 'copies'>): OutboxCopy | undefined =>
  f.evidence_type === 'photo' ? f.copies?.find((c) => c.width === OCR_SOURCE_WIDTH) : undefined;

export async function readPhoto(engine: OcrEngine, f: OutboxFile, categoryName: string | null): Promise<OutboxOcr | null> {
  const src = ocrSource(f);
  if (!src) return null;
  let raw: NativeOcrResult;
  try {
    raw = await engine.recognize(src.local_path);
  } catch {
    return null;
  }
  try {
    const read = mergeReadings(raw);
    const blocks = read.blocks.slice(0, OCR_MAX_BLOCKS).map((b) => ({ ...b, text: b.text.slice(0, OCR_MAX_BLOCK_TEXT) }));
    const description = describePhoto({ categoryName, lines: blocks.map((b) => b.text), coverage: read.coverage });
    return {
      engine_version: engine.version.slice(0, 100),
      lang: read.lang,
      text: read.text.slice(0, OCR_MAX_TEXT),
      blocks,
      mean_confidence: read.mean_confidence,
      description,
      source_width: OCR_SOURCE_WIDTH,
      attempts: 0,
    };
  } catch {
    return null;
  }
}
