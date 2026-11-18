import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  casesToPurge,
  createFileCache,
  createLinkBatcher,
  createPool,
  FileFetchError,
  type FileEntry,
  type FileRecord,
  type FileStore,
  type LinkInfo,
} from "./core";

const sha = async (b: ArrayBuffer) => createHash("sha256").update(new Uint8Array(b)).digest("hex");
const shaSync = (b: ArrayBuffer) => createHash("sha256").update(new Uint8Array(b)).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const CASE_A = "d0000000-0000-4000-8000-00000000000a";
const CASE_B = "d0000000-0000-4000-8000-00000000000b";
const EV = "3e700000-0000-4000-8000-000000000001";

/** In-memory FileStore; `files` is exposed so tests can tamper with stored bytes. */
function memStore() {
  const files = new Map<string, FileRecord>();
  const meta = new Map<string, string>();
  const store: FileStore = {
    async getFile(s) {
      const r = files.get(s);
      return r ? { ...r } : null;
    },
    async putFile(r) {
      files.set(r.sha256, { ...r });
    },
    async touch(s, t) {
      const r = files.get(s);
      if (r) r.lastUsed = t;
    },
    async deleteFiles(list) {
      for (const s of list) files.delete(s);
    },
    async listEntries() {
      return [...files.values()].map((r): FileEntry => {
        const e: Partial<FileRecord> = { ...r };
        delete e.bytes;
        return e as FileEntry;
      });
    },
    async clear() {
      files.clear();
      meta.clear();
    },
    async getMeta(k) {
      return meta.get(k) ?? null;
    },
    async setMeta(k, v) {
      meta.set(k, v);
    },
  };
  return { store, files, meta };
}

function setup(opts: { maxBytes?: number; maxFileBytes?: number; gated?: boolean } = {}) {
  let t = 1_000;
  const m = memStore();
  const cache = createFileCache({ store: m.store, sha256: sha, now: () => t, ...opts });
  return { ...m, cache, tick: (ms: number) => (t += ms), now: () => t };
}
const put = (c: ReturnType<typeof setup>["cache"], s: string, caseId = CASE_A) =>
  c.put({ bytes: bytes(s), expectedSha256: shaSync(bytes(s)), mime: "image/jpeg", caseId, evidenceId: EV, variant: "w384" });

describe("put", () => {
  it("stores bytes only when their SHA-256 matches the expected one", async () => {
    const { cache, files } = setup();
    const good = bytes("photo-1");
    const rec = await cache.put({ bytes: good, expectedSha256: shaSync(good), mime: "image/jpeg", caseId: CASE_A, evidenceId: EV, variant: "w384" });
    expect(rec.sha256).toBe(shaSync(good));
    expect(files.size).toBe(1);
    await expect(
      cache.put({ bytes: bytes("tampered"), expectedSha256: shaSync(bytes("photo-2")), mime: "image/jpeg", caseId: CASE_A, evidenceId: EV, variant: "w384" }),
    ).rejects.toMatchObject({ kind: "integrity" });
    await expect(cache.put({ bytes: good, expectedSha256: "NOT-A-HASH", mime: "x", caseId: CASE_A, evidenceId: EV, variant: "w384" })).rejects.toBeInstanceOf(FileFetchError);
    expect(files.size).toBe(1); // nothing stored by the failures
  });
  it("stores its own copy, so later changes to the caller's buffer cannot slip in", async () => {
    const { cache, files } = setup();
    const u = new TextEncoder().encode("photo-3");
    const expected = shaSync(u.buffer as ArrayBuffer);
    await cache.put({ bytes: u.buffer as ArrayBuffer, expectedSha256: expected, mime: "image/jpeg", caseId: CASE_A, evidenceId: EV, variant: "w384" });
    u[0] = 0; // caller mutates afterwards
    expect(shaSync(files.get(expected)!.bytes)).toBe(expected);
  });
});

describe("get", () => {
  it("re-hashes on every read and deletes a record whose bytes changed", async () => {
    const { cache, files, tick } = setup();
    const rec = await put(cache, "photo-1");
    tick(500);
    expect((await cache.get(rec.sha256))?.lastUsed).toBe(1_500);
    expect(files.get(rec.sha256)?.lastUsed).toBe(1_500);
    files.get(rec.sha256)!.bytes = bytes("swapped on disk");
    expect(await cache.get(rec.sha256)).toBeNull();
    expect(files.has(rec.sha256)).toBe(false);
  });
  it("refuses a record filed under another key and malformed keys", async () => {
    const { cache, files } = setup();
    const rec = await put(cache, "photo-1");
    const other = "ab".repeat(32);
    files.set(other, { ...files.get(rec.sha256)!, sha256: other });
    expect(await cache.get(other)).toBeNull();
    expect(files.has(other)).toBe(false);
    expect(await cache.get("../x")).toBeNull();
  });
});

describe("fetchVerified", () => {
  const link = (b: ArrayBuffer, over: Partial<Extract<LinkInfo, { ok: true }>> = {}): LinkInfo => ({
    ok: true, url: "https://r2.example/x", sha256: shaSync(b), mime: "image/jpeg", variant: "w384", size: b.byteLength, width: 384, ...over,
  });
  it("serves a cache hit without asking for a link or fetching", async () => {
    const { cache } = setup();
    const rec = await put(cache, "photo-1");
    const getLink = vi.fn();
    const fetchBytes = vi.fn();
    const r = await cache.fetchVerified({ evidenceId: EV, caseId: CASE_A, variant: "w384", expectedSha256: rec.sha256, getLink, fetchBytes });
    expect(r.fromCache).toBe(true);
    expect(getLink).not.toHaveBeenCalled();
    expect(fetchBytes).not.toHaveBeenCalled();
  });
  it("on a miss fetches, verifies, stores and returns the bytes", async () => {
    const { cache, files } = setup();
    const b = bytes("photo-9");
    const fetchBytes = vi.fn(async () => b);
    const r = await cache.fetchVerified({ evidenceId: EV, caseId: CASE_A, variant: "w384", expectedSha256: shaSync(b), getLink: async () => link(b), fetchBytes });
    expect(r).toMatchObject({ fromCache: false, sha256: shaSync(b), variant: "w384", mime: "image/jpeg" });
    expect(fetchBytes).toHaveBeenCalledWith("https://r2.example/x");
    expect(files.get(shaSync(b))?.caseId).toBe(CASE_A);
    // second time: hit
    const again = await cache.fetchVerified({ evidenceId: EV, caseId: CASE_A, variant: "w384", expectedSha256: shaSync(b), getLink: vi.fn(), fetchBytes });
    expect(again.fromCache).toBe(true);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });
  it("surfaces an integrity error and stores nothing when the bytes do not match", async () => {
    const { cache, files } = setup();
    const want = bytes("photo-9");
    const evil = bytes("something else");
    await expect(
      cache.fetchVerified({ evidenceId: EV, caseId: CASE_A, variant: "w384", expectedSha256: shaSync(want), getLink: async () => link(want), fetchBytes: async () => evil }),
    ).rejects.toMatchObject({ kind: "integrity", message: expect.stringMatching(/integrity check/) });
    expect(files.size).toBe(0);
  });
  it("refuses when the server and the page disagree on the hash, or the server gives none", async () => {
    const { cache, files } = setup();
    const b = bytes("photo-9");
    const fetchBytes = vi.fn(async () => b);
    await expect(
      cache.fetchVerified({ evidenceId: EV, caseId: CASE_A, variant: "w384", expectedSha256: "cd".repeat(32), getLink: async () => link(b), fetchBytes }),
    ).rejects.toMatchObject({ kind: "integrity" });
    await expect(
      cache.fetchVerified({ evidenceId: EV, caseId: CASE_A, variant: "w384", getLink: async () => link(b, { sha256: null }), fetchBytes }),
    ).rejects.toMatchObject({ kind: "integrity" });
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });
  it("accepts the original when no copy exists, verified against the original's hash", async () => {
    const { cache } = setup();
    const orig = bytes("insurer attachment");
    const r = await cache.fetchVerified({
      evidenceId: EV, caseId: CASE_A, variant: "w384", expectedSha256: "cd".repeat(32),
      getLink: async () => link(orig, { variant: "original", mime: "image/png" }), fetchBytes: async () => orig,
    });
    expect(r).toMatchObject({ variant: "original", mime: "image/png", sha256: shaSync(orig) });
  });
  it("reports link, network and size failures", async () => {
    const { cache } = setup({ maxFileBytes: 10 });
    const b = bytes("0123456789abc");
    const base = { evidenceId: EV, caseId: CASE_A, variant: "w384" as const };
    await expect(cache.fetchVerified({ ...base, getLink: async () => ({ ok: false, error: "Gone." }), fetchBytes: vi.fn() })).rejects.toMatchObject({ kind: "link", message: "Gone." });
    await expect(cache.fetchVerified({ ...base, getLink: async () => { throw new Error("x"); }, fetchBytes: vi.fn() })).rejects.toMatchObject({ kind: "link" });
    await expect(cache.fetchVerified({ ...base, getLink: async () => link(b), fetchBytes: vi.fn() })).rejects.toMatchObject({ kind: "too_large" });
    await expect(cache.fetchVerified({ ...base, getLink: async () => link(b, { size: null }), fetchBytes: async () => b })).rejects.toMatchObject({ kind: "too_large" });
    const small = bytes("abc");
    await expect(cache.fetchVerified({ ...base, getLink: async () => link(small), fetchBytes: async () => { throw new TypeError("offline"); } })).rejects.toMatchObject({ kind: "network" });
  });
});

describe("retention", () => {
  it("wipes everything when another user signs in, keeps files for the same user", async () => {
    const { cache, files, meta } = setup();
    await cache.bindUser("u1");
    await put(cache, "photo-1");
    await cache.bindUser("u1");
    expect(files.size).toBe(1);
    await cache.bindUser("u2");
    expect(files.size).toBe(0);
    expect(meta.get("user")).toBe("u2");
  });
  it("wipes files of an unknown owner on first bind", async () => {
    const { cache, files } = setup();
    await put(cache, "left over");
    await cache.bindUser("u1");
    expect(files.size).toBe(0);
  });
  it("gated: reads and writes wait for bindUser", async () => {
    const { cache, files } = setup({ gated: true });
    let done = false;
    const p = put(cache, "photo-1").then(() => (done = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    expect(files.size).toBe(0);
    await cache.bindUser("u1");
    await p;
    expect(files.size).toBe(1);
    await cache.wipeAll(); // never gated
    expect(files.size).toBe(0);
  });
  it("purges cases, sweeps idle files and lists case ids", async () => {
    const { cache, files, tick, now } = setup();
    await put(cache, "a1", CASE_A);
    await put(cache, "a2", CASE_A);
    await put(cache, "b1", CASE_B);
    expect((await cache.caseIds()).sort()).toEqual([CASE_A, CASE_B]);
    expect(await cache.purgeCases([CASE_A.toUpperCase()])).toBe(2);
    expect(files.size).toBe(1);
    tick(7 * 24 * 3600 * 1000 + 1);
    await put(cache, "fresh", CASE_B);
    expect(await cache.sweep(now())).toBe(1);
    expect([...files.values()].map((f) => f.evidenceId)).toHaveLength(1);
  });
  it("evicts least recently used files above the size cap", async () => {
    const { cache, files, tick } = setup({ maxBytes: 10 });
    const a = await put(cache, "aaaa");
    tick(1);
    const b = await put(cache, "bbbb");
    tick(1);
    await cache.get(a.sha256); // a used more recently than b
    tick(1);
    const c = await put(cache, "cccc");
    expect([...files.keys()].sort()).toEqual([a.sha256, c.sha256].sort());
    expect(files.has(b.sha256)).toBe(false);
    // a file larger than the whole cache is verified and returned, but not stored
    const big = await put(cache, "x".repeat(11));
    expect(big.size).toBe(11);
    expect(files.has(big.sha256)).toBe(false);
  });
  it("keeps working when the store fails", async () => {
    const broken: FileStore = {
      getFile: async () => { throw new Error("idb"); },
      putFile: async () => { throw new Error("quota"); },
      touch: async () => { throw new Error("idb"); },
      deleteFiles: async () => { throw new Error("idb"); },
      listEntries: async () => { throw new Error("idb"); },
      clear: async () => { throw new Error("idb"); },
      getMeta: async () => { throw new Error("idb"); },
      setMeta: async () => { throw new Error("idb"); },
    };
    const cache = createFileCache({ store: broken, sha256: sha, gated: true });
    await cache.bindUser("u1");
    const b = bytes("p");
    const r = await cache.fetchVerified({ evidenceId: EV, caseId: CASE_A, variant: "w384", expectedSha256: shaSync(b), getLink: async () => ({ ok: true, url: "https://x", sha256: shaSync(b), mime: "image/jpeg", variant: "w384", size: 1, width: null }), fetchBytes: async () => b });
    expect(r.fromCache).toBe(false);
    expect(await cache.caseIds()).toEqual([]);
    await cache.wipeAll();
  });
  it("purges finished and no longer visible cases", () => {
    const cached = [CASE_A, CASE_B, "d0000000-0000-4000-8000-00000000000c", "d0000000-0000-4000-8000-00000000000d"];
    expect(
      casesToPurge(cached, [
        { id: CASE_A, status: "office_review" },
        { id: CASE_B.toUpperCase(), status: "submitted" },
        { id: "d0000000-0000-4000-8000-00000000000c", status: "cancelled" },
      ]),
    ).toEqual([CASE_B, "d0000000-0000-4000-8000-00000000000c", "d0000000-0000-4000-8000-00000000000d"]);
    expect(casesToPurge([CASE_A], [{ id: CASE_A, status: "closed" }])).toEqual([CASE_A]);
  });
});

describe("link batcher and pool", () => {
  it("batches ids per variant, 50 per call, and answers every waiter", async () => {
    const calls: { ids: string[]; variant: string }[] = [];
    let fire: (() => void)[] = [];
    const b = createLinkBatcher(
      async (ids, variant) => {
        calls.push({ ids, variant });
        return Object.fromEntries(ids.filter((i) => !i.endsWith("99")).map((i) => [i, { ok: true, url: `https://x/${i}`, sha256: null, mime: "image/jpeg", variant, size: null, width: null } as LinkInfo]));
      },
      { schedule: (fn) => fire.push(fn) },
    );
    const id = (n: number) => `3e700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const ps = Array.from({ length: 55 }, (_, i) => b.get(id(i), "w384"));
    const dup = b.get(id(1).toUpperCase(), "w384");
    const big = b.get(id(99), "w1600");
    fire.forEach((f) => f());
    fire = [];
    const res = await Promise.all([...ps, dup, big]);
    // the first 50 go at once; the rest (and the repeat, whose first batch had left) on the timer
    expect(calls.map((c) => [c.variant, c.ids.length])).toEqual([["w384", 50], ["w384", 6], ["w1600", 1]]);
    expect(res[1]).toEqual(res[55]); // repeated id shares the answer
    expect(res[56]).toMatchObject({ ok: false }); // missing from the reply
  });
  it("turns a failed call into errors", async () => {
    const b = createLinkBatcher(async () => { throw new Error("down"); }, { schedule: (fn) => fn() });
    expect(await b.get("3e700000-0000-4000-8000-000000000001", "original")).toMatchObject({ ok: false });
  });
  it("runs at most n tasks at once", async () => {
    const run = createPool(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
      });
    await Promise.all(Array.from({ length: 7 }, task));
    expect(peak).toBe(2);
  });
});
