import { describe, expect, it } from "vitest";
import { FileFetchError } from "./core";
import { chooseSource, errorState, parseIdList, THUMB_ORIGINAL_MAX_BYTES, toCachedFile } from "./view-core";

const S1 = "a1".repeat(32);
const S384 = "c3".repeat(32);
const S1600 = "c4".repeat(32);
const row = (over: Record<string, unknown> = {}) => ({
  id: "3e700000-0000-4000-8000-000000000001",
  case_id: "d0000000-0000-4000-8000-000000000105",
  evidence_type: "photo",
  mime_type: "image/jpeg",
  sha256: S1,
  size_bytes: 2_400_000,
  evidence_derivatives: [
    { width: 384, sha256: S384, size_bytes: 30_000, pixel_width: 384 },
    { width: 1600, sha256: S1600, size_bytes: 290_000, pixel_width: 1600 },
  ],
  ...over,
});

describe("toCachedFile", () => {
  it("carries the hash of every variant from the database row", () => {
    expect(toCachedFile(row())).toEqual({
      evidenceId: row().id,
      caseId: row().case_id,
      mime: "image/jpeg",
      original: { sha256: S1, size: 2_400_000 },
      w384: { sha256: S384, size: 30_000, width: 384 },
      w1600: { sha256: S1600, size: 290_000, width: 1600 },
    });
  });
  it("skips notes and malformed hashes", () => {
    expect(toCachedFile(row({ evidence_type: "note" }))).toBeNull();
    const f = toCachedFile(row({ sha256: "x", evidence_derivatives: [{ width: 384, sha256: "BAD", size_bytes: 1, pixel_width: 1 }] }));
    expect(f?.original.sha256).toBeNull();
    expect(f?.w384).toBeNull();
    expect(toCachedFile(row({ evidence_derivatives: null }))?.w1600).toBeNull();
  });
});

describe("chooseSource", () => {
  it("uses the 384 copy for thumbnails and the 1600 copy for previews", () => {
    const f = toCachedFile(row())!;
    expect(chooseSource(f, "thumb")).toEqual({ variant: "w384", expectedSha256: S384 });
    expect(chooseSource(f, "preview")).toEqual({ variant: "w1600", expectedSha256: S1600 });
  });
  it("falls back to an inline-safe original when there is no copy", () => {
    const f = toCachedFile(row({ evidence_derivatives: [], mime_type: "image/png" }))!;
    expect(chooseSource(f, "thumb")).toEqual({ variant: "original", expectedSha256: S1 });
    expect(chooseSource(f, "preview")).toEqual({ variant: "original", expectedSha256: S1 });
    const only1600 = toCachedFile(row({ evidence_derivatives: [{ width: 1600, sha256: S1600, size_bytes: 1, pixel_width: 1600 }] }))!;
    expect(chooseSource(only1600, "thumb")?.variant).toBe("w1600");
  });
  it("shows no in-page image for other types or huge originals", () => {
    for (const mime of ["application/pdf", "image/heic", "image/svg+xml", "text/html", null]) {
      const f = toCachedFile(row({ evidence_derivatives: [], mime_type: mime }))!;
      expect(chooseSource(f, "thumb"), String(mime)).toBeNull();
      expect(chooseSource(f, "preview"), String(mime)).toBeNull();
    }
    const huge = toCachedFile(row({ evidence_derivatives: [], size_bytes: THUMB_ORIGINAL_MAX_BYTES + 1 }))!;
    expect(chooseSource(huge, "thumb")).toBeNull();
    expect(chooseSource(huge, "preview")?.variant).toBe("original");
  });
});

describe("helpers", () => {
  it("validates id lists", () => {
    const id = "3E700000-0000-4000-8000-000000000001";
    expect(parseIdList([id, id.toLowerCase()], 5)).toEqual([id.toLowerCase()]);
    expect(parseIdList(["x"], 5)).toBeNull();
    expect(parseIdList("x", 5)).toBeNull();
    expect(parseIdList([id, id, id], 2)).toBeNull();
    expect(parseIdList([], 2)).toEqual([]);
  });
  it("maps errors to UI state", () => {
    expect(errorState(new FileFetchError("integrity"))).toMatchObject({ status: "error", kind: "integrity", message: expect.stringMatching(/integrity check/) });
    expect(errorState(new Error("x"))).toMatchObject({ status: "error", kind: "link" });
  });
});
