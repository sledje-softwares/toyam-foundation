// Loads the composer's case context under RLS (thin, untested): the operator's open task (tasks,
// p_tasks_field_r) and the checklist categories (v_case_checklist + evidence_categories). The last good
// value is kept in a small JSON file so the camera works offline. Call clearCaptureContext() on sign-out.
import { File, Paths } from 'expo-file-system';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { chipsFrom, openTaskId, type CaptureContext } from './context';

const cacheFile = () => new File(Paths.document, 'capture-context.json');
let memory: Record<string, CaptureContext> | null = null;

async function readCache(): Promise<Record<string, CaptureContext>> {
  if (memory) return memory;
  try {
    const f = cacheFile();
    memory = f.exists ? (JSON.parse(await f.text()) as Record<string, CaptureContext>) : {};
  } catch {
    memory = {};
  }
  return memory;
}

async function writeCache(caseId: string, ctx: CaptureContext): Promise<void> {
  const all = { ...(await readCache()), [caseId]: ctx };
  memory = all;
  try {
    const f = cacheFile();
    if (!f.exists) f.create();
    await f.write(JSON.stringify(all));
  } catch {
    // cache only
  }
}

export function clearCaptureContext(): void {
  memory = {};
  try {
    const f = cacheFile();
    if (f.exists) f.delete();
  } catch {
    // nothing to clear
  }
}

async function fetchContext(caseId: string): Promise<CaptureContext | null> {
  const [tasks, list, cats] = await Promise.all([
    supabase.from('tasks').select('id, status, created_at').eq('case_id', caseId),
    supabase.from('v_case_checklist').select('category_id, position').eq('case_id', caseId),
    supabase.from('evidence_categories').select('id, code, name, is_active'),
  ]);
  if (tasks.error || list.error || cats.error) return null;
  return {
    taskId: openTaskId((tasks.data ?? []) as { id: string; status: string; created_at: string }[]),
    chips: chipsFrom(
      (list.data ?? []) as { category_id: string | null; position: number | null }[],
      (cats.data ?? []) as { id: string; code: string; name: string; is_active: boolean }[],
    ),
    loadedAt: new Date().toISOString(),
  };
}

/** `taskId` from the caller wins when given (the thread screen may already know it). A new `refreshKey` reloads (e.g. after "Mark task done"). */
export function useCaptureContext(caseId: string, taskId?: string | null, refreshKey = 0) {
  const [ctx, setCtx] = useState<CaptureContext | null>(null);

  const reload = useCallback(async () => {
    const fresh = await fetchContext(caseId);
    if (fresh) {
      setCtx(fresh);
      await writeCache(caseId, fresh);
    }
  }, [caseId]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const cached = (await readCache())[caseId];
      if (live && cached) setCtx(cached);
      const fresh = await fetchContext(caseId);
      if (!fresh) return;
      if (live) setCtx(fresh);
      await writeCache(caseId, fresh);
    })();
    return () => {
      live = false;
    };
  }, [caseId, refreshKey]);

  const merged = ctx && taskId !== undefined ? { ...ctx, taskId } : ctx ?? (taskId ? { taskId, chips: [], loadedAt: '' } : null);
  return { ctx: merged, reload };
}
