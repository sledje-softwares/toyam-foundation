// What the office sees of a file's OCR (gap 35): the short description made on the field phone and the
// full text. Pure; rows come from an RLS read of evidence_ocr (staff on cases they manage only, rule 4).
//
// - text: the current row of page 1 (a server reading of the original wins over the phone's; the
//   phone's row is then stored beside it, not current), else the newest row.
// - summary: the phone's description (mlkit_device), else the newest row that has one.

export type OcrRow = {
  engine: string;
  text: string;
  summary: string | null;
  is_current: boolean;
  created_at: string;
  page_no?: number | null;
  mean_confidence?: number | null;
};

export type OcrDisplay = {
  summary: string | null;
  text: string | null;
  /** "Phone" for ML Kit on the field phone, otherwise the engine name. */
  engine: string | null;
  confidence: number | null;
};

const newestFirst = (a: OcrRow, b: OcrRow) => b.created_at.localeCompare(a.created_at);

export function ocrDisplay(rows: readonly OcrRow[] | null | undefined): OcrDisplay | null {
  const page1 = (rows ?? []).filter((r) => (r.page_no ?? 1) === 1).sort(newestFirst);
  if (page1.length === 0) return null;
  const textRow = page1.find((r) => r.is_current) ?? page1[0]!;
  const withSummary = page1.filter((r) => r.summary && r.summary.trim());
  const summaryRow = withSummary.find((r) => r.engine === "mlkit_device") ?? withSummary[0] ?? null;
  const text = textRow.text.trim() ? textRow.text : null;
  const summary = summaryRow?.summary?.trim() || null;
  if (!text && !summary) return null;
  return {
    summary,
    text,
    engine: textRow.engine === "mlkit_device" ? "Phone" : textRow.engine,
    confidence: typeof textRow.mean_confidence === "number" ? textRow.mean_confidence : null,
  };
}
