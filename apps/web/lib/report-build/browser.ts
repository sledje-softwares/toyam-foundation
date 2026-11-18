/**
 * Browser wiring of run.ts (7.7, D51): everything runs as the signed-in user. RPCs and the Storage upload use the
 * browser Supabase client (anon key + the user's session; RLS, storage policies and the RPCs' checks decide), photos
 * come from the hash-checked file cache (a hit needs no network; a miss fetches a short link through the batched
 * evidence-view server action and stores the bytes only after their SHA-256 matched), the writers run in the worker.
 * Loaded on the first Generate / Preview only (dynamic import), so the workspace's first load stays small.
 */
import type { Json } from "@/lib/database.types";
import { downloadPool, fetchBytes } from "@/lib/file-cache/browser";
import { FileFetchError, type FileCache, type LinkInfo, type Variant } from "@/lib/file-cache/core";
import { createClient } from "@/lib/supabase/browser";
import type { ImageFetcher } from "@shared/report/assemble.ts";
import { hex } from "@shared/report-generate/logic.ts";
import { expectedSha, variantFor } from "./core";
import { renderReport } from "./render-client";
import { runGenerate, runPreview, type RunDeps } from "./run";

export { runGenerate, runPreview };

export type FileCacheCtx = { cache: () => FileCache; link: (evidenceId: string, variant: Variant) => Promise<LinkInfo> };

const BUCKET = "reports";

/** Photo bytes through the file cache, verified against the hash the database records (never unverified bytes). */
function cacheFetcher(ctx: FileCacheCtx, caseId: string): ImageFetcher {
  return async (src, photo) => {
    const variant = variantFor(src);
    try {
      const r = await ctx.cache().fetchVerified({
        evidenceId: photo.evidence_id,
        caseId,
        variant,
        expectedSha256: expectedSha(photo, src),
        getLink: () => ctx.link(photo.evidence_id, variant),
        fetchBytes: (u) => downloadPool(() => fetchBytes(u)),
      });
      // Another file than asked for (e.g. the original for a copy): its pixel size differs; try the next source.
      if (r.variant !== variant) return { reason: "the copy could not be read" };
      return new Uint8Array(r.bytes);
    } catch (e) {
      if (e instanceof FileFetchError && e.kind === "integrity") return { reason: "the file failed its integrity check" };
      if (e instanceof FileFetchError && e.kind === "too_large") return { reason: "the file is too large" };
      return { reason: "the file could not be downloaded" };
    }
  };
}

export function browserRunDeps(ctx: FileCacheCtx, caseId: string): RunDeps {
  const supabase = createClient();
  return {
    async prepare(id, mode) {
      const { data, error } = await supabase.rpc(mode === "preview" ? "prepare_report_preview" : "prepare_report_version", { p_case_id: id });
      return { data, error };
    },
    fetchPhoto: cacheFetcher(ctx, caseId),
    render: renderReport,
    async sha256(bytes) {
      return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
    },
    async upload(path, bytes, contentType) {
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType }), { contentType, upsert: false });
      return { error: error as never };
    },
    async objectSize(path) {
      const slash = path.lastIndexOf("/");
      const { data, error } = await supabase.storage.from(BUCKET).list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 10 });
      if (error || !data) return null;
      const size = data.find((o) => o.name === path.slice(slash + 1))?.metadata?.size;
      return typeof size === "number" ? size : null;
    },
    async createVersion(args) {
      const { data, error } = await supabase.rpc("create_report_version", {
        ...args,
        p_files: args.p_files as unknown as Json,
        p_photos: args.p_photos as unknown as Json,
        p_notes: args.p_notes ?? undefined,
      });
      return { data, error };
    },
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  };
}
