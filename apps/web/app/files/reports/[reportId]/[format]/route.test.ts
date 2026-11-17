import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentProfile = vi.fn();
const maybeSingle = vi.fn();
const createSignedUrl = vi.fn();
const from = vi.fn();
const storageFrom = vi.fn();

vi.mock("@/lib/auth", () => ({ getCurrentProfile: () => getCurrentProfile(), STAFF_ROLES: ["admin", "orchestrator", "office"] }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from, storage: { from: storageFrom } }),
}));

import { GET } from "./route";

const ID = "3e700000-0000-4000-8000-000000000001";
const call = (reportId: string, format: string) =>
  GET(new Request(`http://localhost/files/reports/${reportId}/${format}`) as never, { params: Promise.resolve({ reportId, format }) });

beforeEach(() => {
  vi.resetAllMocks();
  const q = { select: () => q, eq: () => q, maybeSingle };
  from.mockReturnValue(q);
  storageFrom.mockReturnValue({ createSignedUrl });
});

describe("GET /files/reports/[reportId]/[format]", () => {
  it("rejects a bad id or format before touching anything", async () => {
    expect((await call("nope", "pdf")).status).toBe(404);
    expect((await call(ID, "exe")).status).toBe(404);
    expect(getCurrentProfile).not.toHaveBeenCalled();
  });
  it("sends anonymous users to login", async () => {
    getCurrentProfile.mockResolvedValue(null);
    const r = await call(ID, "pdf");
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get("location")!).pathname).toBe("/login");
    expect(from).not.toHaveBeenCalled();
  });
  it("refuses field operators without reading the database", async () => {
    getCurrentProfile.mockResolvedValue({ id: "u", role: "field", full_name: "F" });
    expect((await call(ID, "pdf")).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
  it("answers 404 when RLS hides the file", async () => {
    getCurrentProfile.mockResolvedValue({ id: "u", role: "office", full_name: "O" });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect((await call(ID, "pdf")).status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
  it("redirects to a 60 s signed URL with a download name", async () => {
    getCurrentProfile.mockResolvedValue({ id: "u", role: "office", full_name: "O" });
    maybeSingle.mockResolvedValue({ data: { storage_path: "c/r/report.pdf", reports: { version: 4, cases: { case_ref: "INV-2026-000008" } } }, error: null });
    createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://storage.example/signed?t=1" }, error: null });
    const r = await call(ID, "pdf");
    expect(storageFrom).toHaveBeenCalledWith("reports");
    expect(createSignedUrl).toHaveBeenCalledWith("c/r/report.pdf", 60, { download: "INV-2026-000008_v4.pdf" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://storage.example/signed?t=1");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
  it("answers 502 when the database or signing fails", async () => {
    getCurrentProfile.mockResolvedValue({ id: "u", role: "admin", full_name: "A" });
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await call(ID, "docx")).status).toBe(502);
    maybeSingle.mockResolvedValue({ data: { storage_path: "p", reports: [{ version: 1, cases: [{ case_ref: "INV-1" }] }] }, error: null });
    createSignedUrl.mockResolvedValue({ data: null, error: { message: "x" } });
    expect((await call(ID, "docx")).status).toBe(502);
  });
});
