import { describe, expect, it } from "vitest";
import { photoKey } from "@shared/report/assemble.ts";
import { LayoutError } from "@shared/report/bind.ts";
import type { RenderFilesInput, RenderFilesOutput } from "@shared/report/files.ts";
import { defaultLayout } from "@shared/report/spec.ts";
import type { PreparedPhoto, PreparedReport } from "@shared/report-generate/logic.ts";
import { asCreated, asPrepared, expectedSha, isAlreadyExists, isResumable, renderFailure, variantFor } from "./core";
import { runGenerate, runPreview, type CreateVersionArgs, type RunDeps } from "./run";
import { buttonState, IDLE, previewFileName, progressText, userMessage, type Progress } from "./ui";

// Fictional data only.
const CASE = "7e500000-0000-4000-8000-000000000001";
const TASK = "7e600000-0000-4000-8000-000000000001";
const sha = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const evId = (n: number) => `7e700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECTIONS = [
  { key: "insured", title: "Insured details", position: 1, fields: [{ key: "insured_name", label: "Insured name", type: "text", value: "A. Example" }] },
  { key: "garage", title: "Garage visit", position: 2, fields: [] },
];

function photo(n: number, over: Partial<PreparedPhoto> = {}): PreparedPhoto {
  return {
    evidence_id: evId(n),
    section_key: "garage",
    position: n,
    caption: `Photo ${n}`,
    category_name: "Vehicle",
    evidence_type: "photo",
    mime_type: "image/jpeg",
    storage_backend: "r2",
    storage_path: `cases/${CASE}/tasks/${TASK}/${sha(n)}.jpg`,
    sha256: sha(n),
    size_bytes: 400_000,
    derivatives: [
      { width: 384, storage_path: `derived/${CASE}/${sha(n)}/w384.jpg`, sha256: sha(n + 100), size_bytes: 30_000, pixel_width: 384, pixel_height: 288 },
      { width: 1600, storage_path: `derived/${CASE}/${sha(n)}/w1600.jpg`, sha256: sha(n + 200), size_bytes: 300_000, pixel_width: 1600, pixel_height: 1200 },
    ],
    ...over,
  };
}

function prepared(over: Partial<PreparedReport> = {}): PreparedReport {
  return {
    case: { id: CASE, case_ref: "INV-2026-000042", insurer: { code: "EXM", name: "Example General" }, office_owner: { id: "u", name: "O. Office" } },
    template: { id: "t-1", key: "exm", name: "Example", version: 1, output_formats: ["pdf", "docx"] },
    report_layout: defaultLayout(SECTIONS),
    values_token: "v1:abc",
    next_version: 3,
    sections: SECTIONS,
    photos: [photo(1), photo(2)],
    ...over,
  };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

type Calls = { prepare: string[]; fetch: string[]; render: RenderFilesInput[]; upload: string[]; create: CreateVersionArgs[] };

function fakeDeps(o: {
  prepared?: unknown;
  prepareError?: { code: string; message: string };
  fetch?: (variant: string, p: PreparedPhoto) => Uint8Array | null | { reason: string };
  render?: (input: RenderFilesInput) => RenderFilesOutput;
  upload?: (path: string, n: number) => { error: { statusCode?: string; message?: string } | null };
  objectSize?: number | null;
  create?: (args: CreateVersionArgs, n: number) => { data: unknown; error: { code: string; message: string } | null };
  ids?: string[];
} = {}): { deps: RunDeps; calls: Calls } {
  const calls: Calls = { prepare: [], fetch: [], render: [], upload: [], create: [] };
  const ids = [...(o.ids ?? ["7e900000-0000-4000-8000-000000000001", "7e900000-0000-4000-8000-000000000002"])];
  const deps: RunDeps = {
    async prepare(id, mode) {
      calls.prepare.push(mode);
      return o.prepareError ? { data: null, error: o.prepareError } : { data: o.prepared ?? prepared(), error: null };
    },
    async fetchPhoto(src, p) {
      const v = variantFor(src);
      calls.fetch.push(`${p.position}:${v}`);
      return o.fetch ? o.fetch(v, p) : JPEG;
    },
    async render(input, onStep) {
      calls.render.push(input);
      if (o.render) return o.render(input);
      const files = [];
      for (const format of input.formats) {
        onStep(format);
        files.push({ format, bytes: new TextEncoder().encode(format === "pdf" ? "%PDF-1.7 fake" : "PK fake docx") });
      }
      const placedKeys = Object.entries(input.data.photos ?? {}).flatMap(([s, list]) => list.filter((p) => p.image).map((p) => photoKey(s, p.evidence_id)));
      return { files, warnings: [], placedKeys };
    },
    async sha256(bytes) {
      return bytes.length.toString(16).padStart(64, "0");
    },
    async upload(path) {
      calls.upload.push(path);
      return o.upload ? o.upload(path, calls.upload.length) : { error: null };
    },
    async objectSize() {
      return o.objectSize ?? null;
    },
    async createVersion(args) {
      calls.create.push(args);
      return o.create ? o.create(args, calls.create.length) : { data: { report_id: args.p_report_id, version: 3, created: true }, error: null };
    },
    now: () => new Date("2026-11-18T06:00:00Z"),
    newId: () => ids.shift() ?? "7e900000-0000-4000-8000-0000000000ff",
  };
  return { deps, calls };
}

const progressOf = () => {
  const seen: Progress[] = [];
  return { seen, on: (p: Progress) => seen.push(p) };
};

describe("photo sources → file cache", () => {
  it("maps device copies and originals to the evidence-view variant and the hash the database records", () => {
    const p = photo(1);
    const src = (kind: "copy384" | "copy1600" | "original") => ({ store: "r2" as const, path: "x", size: 1, kind });
    expect(variantFor(src("copy384"))).toBe("w384");
    expect(variantFor(src("copy1600"))).toBe("w1600");
    expect(variantFor(src("original"))).toBe("original");
    expect(expectedSha(p, src("copy384"))).toBe(sha(101));
    expect(expectedSha(p, src("copy1600"))).toBe(sha(201));
    expect(expectedSha(p, src("original"))).toBe(sha(1));
    expect(expectedSha(photo(1, { sha256: "not-a-hash", derivatives: [] }), src("original"))).toBeNull();
    expect(expectedSha(photo(1, { derivatives: [] }), src("copy1600"))).toBeNull();
  });
});

describe("answers and errors", () => {
  it("accepts only a prepare / create answer of the expected shape", () => {
    expect(asPrepared(prepared())).not.toBeNull();
    expect(asPrepared({ ...prepared(), values_token: 1 })).toBeNull();
    expect(asPrepared(null)).toBeNull();
    expect(asCreated({ report_id: "r", version: 2, created: false })).toEqual({ report_id: "r", version: 2, created: false });
    expect(asCreated({ report_id: "r" })).toBeNull();
  });

  it("recognises Storage's already-exists answer", () => {
    expect(isAlreadyExists({ statusCode: "409", message: "The resource already exists" })).toBe(true);
    expect(isAlreadyExists({ status: 400, statusCode: null, message: "Duplicate" })).toBe(true);
    expect(isAlreadyExists({ status: 400, code: "ResourceAlreadyExists", message: "x" })).toBe(true);
    expect(isAlreadyExists({ statusCode: "403", message: "new row violates row-level security policy" })).toBe(false);
    expect(isAlreadyExists(null)).toBe(false);
  });

  it("maps layout and writer errors, including a LayoutError that crossed the worker boundary", () => {
    expect(renderFailure(new LayoutError(["bad block"])).error).toMatchObject({ code: "invalid_layout", issues: ["bad block"] });
    expect(renderFailure({ name: "LayoutError", message: "x", issues: ["a", 1] }).error).toMatchObject({ code: "invalid_layout", issues: ["a"] });
    expect(renderFailure(new Error("boom")).error.code).toBe("pdf_failed");
  });

  it("shows the database's messages and the RV409 / session sentences", () => {
    const f = (code: string, message = "m") => ({ status: 409, error: { code: code as never, message } });
    expect(userMessage(f("values_changed"))).toMatch(/changed the report fields while it was generating.*generate it again/);
    expect(userMessage(f("not_editable", "The case is closed"))).toBe("The case is closed");
    expect(userMessage(f("unauthorized"))).toBe("Your session has ended. Sign in again.");
    expect(userMessage(f("upload_failed", "The report files could not be stored. Try again."), true)).toMatch(/files are kept/);
    expect(isResumable(f("upload_failed"))).toBe(true);
    expect(isResumable(f("upstream_error"))).toBe(true);
    expect(isResumable(f("values_changed"))).toBe(false);
    expect(isResumable(f("forbidden"))).toBe(false);
  });
});

describe("progress and button", () => {
  it("names each step", () => {
    expect(progressText({ phase: "preparing" })).toBe("Preparing…");
    expect(progressText({ phase: "photos", done: 3, total: 30 })).toBe("Photos 3/30…");
    expect(progressText({ phase: "pdf" })).toBe("Writing PDF…");
    expect(progressText({ phase: "docx" })).toBe("Writing Word file…");
    expect(progressText({ phase: "uploading" })).toBe("Uploading…");
  });

  it("disables the button while running and offers a retry when the files are kept", () => {
    expect(buttonState(IDLE, true)).toEqual({ disabled: false, label: "Generate report" });
    expect(buttonState(IDLE, false).disabled).toBe(true);
    expect(buttonState({ status: "running", progress: { phase: "pdf" } }, true)).toEqual({ disabled: true, label: "Generating report…" });
    expect(buttonState({ status: "error", message: "x", warnings: [], resumable: true }, true).label).toBe("Retry saving the report");
    expect(buttonState({ status: "error", message: "x", warnings: [], resumable: false }, true).label).toBe("Generate report");
    expect(previewFileName("INV-2026/000042")).toBe("INV-2026_000042_preview.pdf");
  });
});

describe("runGenerate", () => {
  it("prepares, loads the 1600 px copies, writes PDF + Word, uploads both and records the placed photos", async () => {
    const { deps, calls } = fakeDeps();
    const pr = progressOf();
    const r = await runGenerate(deps, { caseId: CASE }, pr.on);
    expect(r).toMatchObject({ ok: true, version: 3, created: true, warnings: [] });
    expect(calls.prepare).toEqual(["generate"]);
    expect(calls.fetch.sort()).toEqual(["1:w1600", "2:w1600"]);
    expect(calls.render[0].formats).toEqual(["pdf", "docx"]);
    const id = "7e900000-0000-4000-8000-000000000001";
    expect(calls.upload).toEqual([`${CASE}/${id}/report.pdf`, `${CASE}/${id}/report.docx`]);
    const c = calls.create[0];
    expect(c).toMatchObject({ p_case_id: CASE, p_report_id: id, p_values_token: "v1:abc", p_notes: null });
    expect(c.p_files.map((f) => [f.format, f.storage_path, f.size_bytes])).toEqual([
      ["pdf", `${CASE}/${id}/report.pdf`, 13],
      ["docx", `${CASE}/${id}/report.docx`, 12],
    ]);
    expect(c.p_files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.p_photos).toEqual([
      { evidence_id: evId(1), section_key: "garage", position: 1, caption: "Photo 1" },
      { evidence_id: evId(2), section_key: "garage", position: 2, caption: "Photo 2" },
    ]);
    expect(pr.seen.map((p) => p.phase)).toEqual(["preparing", "photos", "photos", "photos", "pdf", "docx", "uploading"]);
    expect(pr.seen[3]).toEqual({ phase: "photos", done: 2, total: 2 });
  });

  it("falls back to the original when the copy fails; a photo with no verified bytes is a placeholder, warned about, not recorded", async () => {
    const { deps, calls } = fakeDeps({
      fetch: (v, p) => (p.position === 1 ? (v === "w1600" ? { reason: "the file failed its integrity check" } : JPEG) : { reason: "the file failed its integrity check" }),
    });
    const r = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r.ok).toBe(true);
    expect(calls.fetch.sort()).toEqual(["1:original", "1:w1600", "2:original", "2:w1600"]);
    expect(calls.create[0].p_photos.map((p) => p.evidence_id)).toEqual([evId(1)]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Photo "Photo 2" \(Garage visit\): the file failed its integrity check; an empty box/);
    expect(calls.render[0].data.photos?.garage.map((p) => p.image === null)).toEqual([false, true]);
  });

  it("writes only the formats the template allows", async () => {
    const { deps, calls } = fakeDeps({ prepared: prepared({ template: { id: "t", output_formats: ["docx"] } }) });
    await runGenerate(deps, { caseId: CASE }, () => {});
    expect(calls.render[0].formats).toEqual(["docx"]);
    expect(calls.upload).toHaveLength(1);
  });

  it("stops before any work when the database refuses (status, access) or the template cannot be written", async () => {
    let { deps, calls } = fakeDeps({ prepareError: { code: "55000", message: "The case is closed" } });
    let r = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r).toMatchObject({ ok: false, attempt: null, failure: { error: { code: "not_editable", message: "The case is closed" } } });
    expect(calls.fetch).toEqual([]);

    ({ deps, calls } = fakeDeps({ prepareError: { code: "42501", message: "Only the case owner, an orchestrator or an admin can generate this report" } }));
    r = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r).toMatchObject({ ok: false, failure: { error: { code: "forbidden" } } });

    ({ deps, calls } = fakeDeps({ prepared: prepared({ report_layout: null }) }));
    r = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r).toMatchObject({ ok: false, failure: { error: { code: "no_layout" } } });
    expect(calls.render).toEqual([]);

    ({ deps, calls } = fakeDeps({ prepared: { nonsense: true } }));
    r = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r).toMatchObject({ ok: false, failure: { error: { code: "upstream_error" } } });
  });

  it("maps a writer failure and uploads nothing", async () => {
    const { deps, calls } = fakeDeps({ render: () => { throw new LayoutError(["x"]); } });
    const r = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r).toMatchObject({ ok: false, attempt: null, failure: { error: { code: "invalid_layout" } } });
    expect(calls.upload).toEqual([]);
  });

  it("RV409: drops the attempt, so the next click prepares again with a new report id", async () => {
    const { deps, calls } = fakeDeps({
      create: (args, n) => (n === 1 ? { data: null, error: { code: "RV409", message: "The report values changed" } } : { data: { report_id: args.p_report_id, version: 4, created: true }, error: null }),
    });
    const r1 = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r1).toMatchObject({ ok: false, attempt: null, failure: { error: { code: "values_changed" } } });
    const r2 = await runGenerate(deps, { caseId: CASE, attempt: r1.ok ? null : r1.attempt }, () => {});
    expect(r2.ok).toBe(true);
    expect(calls.prepare).toEqual(["generate", "generate"]);
    expect(calls.create.map((c) => c.p_report_id)).toEqual(["7e900000-0000-4000-8000-000000000001", "7e900000-0000-4000-8000-000000000002"]);
    // the document prints the version prepare promised (3); recorded as 4 → warning
    expect(r2.ok && r2.warnings.at(-1)).toMatch(/this one is version 4, but the document prints version 3/);
  });

  it("a failed upload keeps the attempt; the retry uploads only the rest with the same report id and does not rebuild", async () => {
    const { deps, calls } = fakeDeps({ upload: (_p, n) => (n === 2 ? { error: { statusCode: "500", message: "Internal" } } : { error: null }) });
    const r1 = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.failure.error.code).toBe("upload_failed");
    expect(r1.attempt?.uploaded).toEqual(["pdf"]);
    const pr = progressOf();
    const r2 = await runGenerate(deps, { caseId: CASE, attempt: r1.attempt }, pr.on);
    expect(r2.ok).toBe(true);
    expect(calls.prepare).toHaveLength(1);
    expect(calls.render).toHaveLength(1);
    const id = "7e900000-0000-4000-8000-000000000001";
    expect(calls.upload).toEqual([`${CASE}/${id}/report.pdf`, `${CASE}/${id}/report.docx`, `${CASE}/${id}/report.docx`]);
    expect(calls.create.map((c) => c.p_report_id)).toEqual([id]);
    expect(pr.seen.map((p) => p.phase)).toEqual(["uploading"]);
  });

  it("an upload whose answer was lost (already exists, same size) counts as done; another size starts over", async () => {
    let { deps, calls } = fakeDeps({ upload: () => ({ error: { statusCode: "409", message: "The resource already exists" } }), objectSize: 13 });
    // pdf is 13 bytes; docx 12 → mismatch on the second file
    let r = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r).toMatchObject({ ok: false, attempt: null, failure: { error: { code: "invalid_case" } } });
    expect(calls.create).toEqual([]);

    ({ deps, calls } = fakeDeps({
      prepared: prepared({ template: { id: "t", output_formats: ["pdf"] } }),
      upload: () => ({ error: { statusCode: "409", message: "The resource already exists" } }),
      objectSize: 13,
    }));
    r = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r.ok).toBe(true);
    expect(calls.create).toHaveLength(1);
  });

  it("a lost create answer: the retry calls create_report_version again with the same id (created: false is success)", async () => {
    const { deps, calls } = fakeDeps({
      create: (args, n) => (n === 1 ? { data: null, error: { code: "", message: "TypeError: Failed to fetch" } } : { data: { report_id: args.p_report_id, version: 3, created: false }, error: null }),
    });
    const r1 = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r1).toMatchObject({ ok: false, failure: { error: { code: "upstream_error" } } });
    if (r1.ok) return;
    expect(r1.attempt?.uploaded).toEqual(["pdf", "docx"]);
    const r2 = await runGenerate(deps, { caseId: CASE, attempt: r1.attempt }, () => {});
    expect(r2).toMatchObject({ ok: true, version: 3, created: false });
    expect(calls.upload).toHaveLength(2);
    expect(new Set(calls.create.map((c) => c.p_report_id)).size).toBe(1);
  });

  it("a refusal from create_report_version drops the attempt", async () => {
    const { deps } = fakeDeps({ create: () => ({ data: null, error: { code: "55000", message: "The report is waiting for approval or approved, so no new version can be made" } }) });
    const r = await runGenerate(deps, { caseId: CASE }, () => {});
    expect(r).toMatchObject({ ok: false, attempt: null, failure: { error: { code: "not_editable" } } });
  });

  it("an attempt of another case is ignored", async () => {
    const { deps, calls } = fakeDeps({ upload: (_p, n) => (n === 1 ? { error: { statusCode: "500" } } : { error: null }) });
    const r1 = await runGenerate(deps, { caseId: CASE }, () => {});
    if (r1.ok) throw new Error("expected a failure");
    await runGenerate(deps, { caseId: "7e500000-0000-4000-8000-000000000999", attempt: r1.attempt }, () => {});
    expect(calls.prepare).toHaveLength(2);
  });
});

describe("runPreview", () => {
  it("uses prepare_report_preview, the 384 px copies and writes only the PDF", async () => {
    const { deps, calls } = fakeDeps();
    const r = await runPreview(deps, CASE, () => {});
    expect(r.ok).toBe(true);
    expect(calls.prepare).toEqual(["preview"]);
    expect(calls.fetch.sort()).toEqual(["1:w384", "2:w384"]);
    expect(calls.render[0].formats).toEqual(["pdf"]);
    expect(calls.upload).toEqual([]);
    expect(calls.create).toEqual([]);
  });

  it("works for a template without output formats and in locked statuses (the database decides)", async () => {
    const { deps } = fakeDeps({ prepared: prepared({ template: { id: "t", output_formats: [] } }) });
    expect((await runPreview(deps, CASE, () => {})).ok).toBe(true);
  });
});
