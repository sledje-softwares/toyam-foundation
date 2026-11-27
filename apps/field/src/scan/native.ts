// Native adapter for the document scanner (thin, untested here). The module is the local Expo module
// `modules/toyam-scanner`. Missing module (Expo Go, web, an old dev build) = no "Scan document" row.
import { requireOptionalNativeModule } from 'expo';

export interface ScannedPage {
  uri: string;
  width: number;
  height: number;
}

interface ToyamScannerNative {
  /** One JPEG per page; empty when the operator cancels. */
  scan(pageLimit: number): Promise<ScannedPage[]>;
}

export const scanner = requireOptionalNativeModule<ToyamScannerNative>('ToyamScanner');
