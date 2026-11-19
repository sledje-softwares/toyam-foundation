// Native adapter for device OCR (thin, untested here; logic in ./read.ts, ./blocks.ts). The module is the
// local Expo module `modules/toyam-ocr` (ML Kit, bundled Latin + Devanagari models). Missing module
// (Expo Go, web, an old dev build) = no device OCR; the files are sent as usual.
import { requireOptionalNativeModule } from 'expo';
import type { NativeOcrResult } from './blocks';
import type { OcrEngine } from './read';

interface ToyamOcrNative {
  engineVersion(): string;
  recognize(uri: string, scripts: string[]): Promise<NativeOcrResult>;
}

const native = requireOptionalNativeModule<ToyamOcrNative>('ToyamOcr');

/** Both scripts on every photo: Indian documents mix English and Hindi / Marathi. */
const SCRIPTS = ['latin', 'devanagari'];

export const ocrEngine: OcrEngine | null = native
  ? {
      version: (() => {
        try {
          return native.engineVersion();
        } catch {
          return 'mlkit';
        }
      })(),
      recognize: (uri) => native.recognize(uri, SCRIPTS),
    }
  : null;
