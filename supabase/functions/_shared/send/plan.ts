// Size handling (8.3) and portal pack naming (8.4). Pure.
import { extOf, safeName } from './render.ts';

export const MB = 1024 * 1024;

export interface PlanInput {
  /** Sizes in bytes of the report files chosen for sending. */
  reportBytes: number[];
  /** Size of the annexure zip actually built (0 = no annexures). */
  annexZipBytes: number;
  /** Largest attachment total before email encoding (settings: send_attach_max_mb). */
  attachMaxBytes: number;
}
export type Delivery =
  | { kind: 'attached'; attachReport: true; attachAnnex: boolean }
  /** Report files attached; annexure zip as a secure link. */
  | { kind: 'link'; attachReport: true; attachAnnex: false; linkWhat: 'annexures' }
  /** Report too big to attach: everything (report + annexures) in one pack behind a link. */
  | { kind: 'link'; attachReport: false; attachAnnex: false; linkWhat: 'everything' };

export function planDelivery(i: PlanInput): Delivery {
  const report = i.reportBytes.reduce((a, b) => a + b, 0);
  if (report > i.attachMaxBytes) return { kind: 'link', attachReport: false, attachAnnex: false, linkWhat: 'everything' };
  if (i.annexZipBytes === 0) return { kind: 'attached', attachReport: true, attachAnnex: false };
  if (report + i.annexZipBytes <= i.attachMaxBytes) return { kind: 'attached', attachReport: true, attachAnnex: true };
  return { kind: 'link', attachReport: true, attachAnnex: false, linkWhat: 'annexures' };
}

export interface PackAnnexure {
  position: number;
  section_key: string | null;
  section_title?: string | null;
  caption: string | null;
  original_filename: string | null;
  mime_type: string | null;
}

/**
 * File names inside a pack, numbered in the order the portal expects: the report first (`01_…`), then the
 * annexures in report order (`02_Annexure_…`). ASCII only, unique, with the original extension.
 */
export function packNames(base: string, reportFormats: string[], annexures: PackAnnexure[], withReport: boolean): {
  report: string[]; annexures: string[];
} {
  const used = new Set<string>();
  let n = 0;
  const pad = (k: number) => String(k).padStart(2, '0');
  const uniq = (stem: string, ext: string) => {
    let name = `${stem}.${ext}`, i = 2;
    while (used.has(name.toLowerCase())) name = `${stem}_${i++}.${ext}`;
    used.add(name.toLowerCase());
    return name;
  };
  const report = withReport ? reportFormats.map((f) => uniq(`${pad(++n)}_${safeName(base, 60)}`, f)) : [];
  const sorted = [...annexures].sort((a, b) => a.position - b.position);
  const names = sorted.map((a) => {
    const label = safeName([a.section_title ?? a.section_key ?? '', a.caption ?? ''].filter(Boolean).join(' ') || a.original_filename || 'file', 50);
    return uniq(`${pad(++n)}_Annexure_${label}`, extOf(a.original_filename, a.mime_type));
  });
  // `names` follows `sorted`; map back to the caller's order
  const byPos = new Map(sorted.map((a, i) => [a, names[i]]));
  return { report, annexures: annexures.map((a) => byPos.get(a)!) };
}
