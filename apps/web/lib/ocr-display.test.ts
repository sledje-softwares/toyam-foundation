import { describe, expect, it } from "vitest";
import { ocrDisplay, type OcrRow } from "./ocr-display";

const row = (o: Partial<OcrRow>): OcrRow => ({
  engine: "mlkit_device",
  text: "MH 12 AB 3456",
  summary: null,
  is_current: true,
  created_at: "2026-11-19T10:00:00Z",
  page_no: 1,
  mean_confidence: 0.9,
  ...o,
});

describe("ocrDisplay", () => {
  it("nothing without rows or without any text / summary", () => {
    expect(ocrDisplay(null)).toBeNull();
    expect(ocrDisplay([])).toBeNull();
    expect(ocrDisplay([row({ text: "  ", summary: null })])).toBeNull();
  });

  it("the phone's row: its summary and text", () => {
    expect(ocrDisplay([row({ summary: "Registration certificate; text read from the 1600 px copy: MH 12 AB 3456" })])).toEqual({
      summary: "Registration certificate; text read from the 1600 px copy: MH 12 AB 3456",
      text: "MH 12 AB 3456",
      engine: "Phone",
      confidence: 0.9,
    });
  });

  it("server text wins when current; the summary still comes from the phone", () => {
    const d = ocrDisplay([
      row({ is_current: false, summary: "Photo; text read from the 1600 px copy: MH 12", created_at: "2026-11-19T10:00:00Z" }),
      row({ engine: "paddleocr", text: "MH 12 AB 3456 full", summary: null, is_current: true, created_at: "2026-11-19T10:05:00Z", mean_confidence: null }),
    ]);
    expect(d).toEqual({ summary: "Photo; text read from the 1600 px copy: MH 12", text: "MH 12 AB 3456 full", engine: "paddleocr", confidence: null });
  });

  it("no current row: the newest; other pages are ignored", () => {
    const d = ocrDisplay([
      row({ is_current: false, text: "old", created_at: "2026-11-19T09:00:00Z" }),
      row({ is_current: false, text: "new", created_at: "2026-11-19T11:00:00Z" }),
      row({ page_no: 2, text: "page two" }),
    ]);
    expect(d?.text).toBe("new");
  });

  it("a summary with no text (photo without text) is still shown", () => {
    expect(ocrDisplay([row({ text: "", summary: "Front view; no text read" })])).toMatchObject({ summary: "Front view; no text read", text: null });
  });
});
