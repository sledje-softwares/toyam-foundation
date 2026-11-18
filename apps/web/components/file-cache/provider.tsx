"use client";

import { createContext, useContext, useEffect, useMemo } from "react";
import { casesToPurge, type FileCache, type LinkInfo, type Variant } from "@/lib/file-cache/core";
import { browserFileCache, browserLinkBatcher } from "@/lib/file-cache/browser";
import { fileCacheCaseStatuses, fileCacheLinks } from "@/lib/file-cache/actions";

type Ctx = { cache: () => FileCache; link: (evidenceId: string, variant: Variant) => Promise<LinkInfo> };
const FileCacheContext = createContext<Ctx | null>(null);

/** null outside the signed-in app (no cache there). */
export function useFileCache(): Ctx | null {
  return useContext(FileCacheContext);
}

let housekeptFor: string | null = null;

/**
 * Binds the browser file cache to the signed-in user (another user's files are wiped first; reads and writes wait for
 * this), then once per page load: purges cached files of cases that are finished or no longer visible to the user
 * (statuses read under RLS) and files idle for 7 days.
 */
export function FileCacheProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  useEffect(() => {
    const cache = browserFileCache();
    void (async () => {
      await cache.bindUser(userId);
      if (housekeptFor === userId) return;
      housekeptFor = userId;
      try {
        const ids = (await cache.caseIds()).slice(0, 1000); // the action's limit; the rest on a later load
        if (ids.length) {
          const r = await fileCacheCaseStatuses(ids);
          if (r.ok) await cache.purgeCases(casesToPurge(ids, r.cases));
        }
        await cache.sweep(Date.now());
      } catch {
        // housekeeping is best effort; the next page load tries again
        housekeptFor = null;
      }
    })();
  }, [userId]);

  const value = useMemo<Ctx>(
    () => ({ cache: browserFileCache, link: (id, variant) => browserLinkBatcher(fileCacheLinks).get(id, variant) }),
    [],
  );
  return <FileCacheContext.Provider value={value}>{children}</FileCacheContext.Provider>;
}
