import { describe, expect, it } from "vitest";
import {
  batchBodies,
  fileHref,
  GENERIC_LINK_FAILURE,
  hasThumbnail,
  linkErrorMessage,
  linkKey,
  mergeResults,
  parseViewReply,
} from "./evidence-view-core";

const id = (n: number, prefix = "3e70") => `${prefix}0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("batchBodies", () => {
  it("drops invalid ids and repeats, keeps kinds apart", () => {
    expect(batchBodies([id(1), id(1).toUpperCase(), "nope"], [id(1)], "inline")).toEqual([
      { evidence_ids: [id(1)], attachment_ids: [id(1)], disposition: "inline" },
    ]);
    expect(batchBodies([], [], "inline")).toEqual([]);
  });
  it("splits into calls of at most 50 ids", () => {
    const b = batchBodies(
      Array.from({ length: 60 }, (_, i) => id(i)),
      Array.from({ length: 45 }, (_, i) => id(i, "3e80")),
      "attachment",
    );
    expect(b.map((x) => (x.evidence_ids?.length ?? 0) + (x.attachment_ids?.length ?? 0))).toEqual([50, 50, 5]);
    expect(b[0].attachment_ids).toBeUndefined();
    expect(b[1]).toMatchObject({ disposition: "attachment" });
    expect(b[2].evidence_ids).toBeUndefined();
  });
});

describe("parseViewReply", () => {
  it("reads links and per-file errors", () => {
    const r = parseViewReply({
      ok: true,
      files: [
        { kind: "evidence", id: id(1), url: "https://acct.r2.cloudflarestorage.com/x", expires_at: "t", content_type: "image/jpeg", file_name: "a.jpg", disposition: "inline" },
        { kind: "evidence", id: id(2), error: "not_found" },
        { kind: "attachment", id: id(3), url: "javascript:alert(1)" },
        { kind: "other", id: id(4), url: "https://x" },
        null,
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.links.get(linkKey("evidence", id(1)))?.file_name).toBe("a.jpg");
    expect(r.errors.get(linkKey("evidence", id(2)))).toBe("not_found");
    expect(r.links.size).toBe(1); // non-http and unknown kinds are dropped
  });
  it("maps function failures to readable text", () => {
    expect(parseViewReply({ ok: false, error: { code: "storage_not_configured" } })).toEqual({
      ok: false,
      code: "storage_not_configured",
      message: linkErrorMessage("storage_not_configured"),
    });
    expect(parseViewReply("x")).toMatchObject({ ok: false, code: "internal", message: GENERIC_LINK_FAILURE });
  });
});

describe("mergeResults", () => {
  it("keeps partial success and only fails when nothing came back", () => {
    const good = parseViewReply({ ok: true, files: [{ kind: "evidence", id: id(1), url: "https://x/1" }] });
    const bad = parseViewReply({ ok: false, error: { code: "rate_limited" } });
    const m = mergeResults([bad, good]);
    expect(m.ok && m.links.size).toBe(1);
    expect(mergeResults([bad])).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("helpers", () => {
  it("previews only browser-safe images", () => {
    expect(hasThumbnail("image/jpeg")).toBe(true);
    expect(hasThumbnail("IMAGE/PNG; x=1")).toBe(true);
    expect(hasThumbnail("image/heic")).toBe(false);
    expect(hasThumbnail("image/svg+xml")).toBe(false);
    expect(hasThumbnail(null)).toBe(false);
  });
  it("builds same-origin redirect paths", () => {
    expect(fileHref("evidence", id(1))).toBe(`/files/evidence/${id(1)}`);
    expect(fileHref("attachment", id(1), { download: true })).toBe(`/files/attachment/${id(1)}?download=1`);
  });
});
