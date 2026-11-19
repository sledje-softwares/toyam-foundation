// Network reads for the cache (thin, untested). RLS limits every query to this operator's cases.
import { supabase } from '../lib/supabase';
import type { CaseRow } from '../lib/cases';
import type { ChecklistRow } from '../ui-logic/offline';
import type { OpenTaskRow, RpcErrorLike } from '../ui-logic/taskDone';
import { MESSAGE_LIMIT, type OpenTask } from './logic';
import type { ProcState, ServerFile } from '../thread/model';
import type { CaseHeader, Msg, ThreadFiles } from './caseCache';

export async function fetchCaseList(): Promise<CaseRow[] | null> {
  const { data, error } = await supabase.rpc('field_case_list');
  return error ? null : ((data ?? []) as CaseRow[]);
}

export async function fetchOpenTasks(): Promise<OpenTask[] | null> {
  const { data, error } = await supabase.from('tasks').select('id, case_id, created_at').in('status', ['pending', 'in_progress']);
  if (error) return null;
  return (data ?? []).map((t) => ({ task_id: String(t.id), case_id: String(t.case_id), created_at: String(t.created_at) }));
}

export async function fetchHeader(caseId: string, base: { case_ref: string; title: string | null; insurer_name: string }): Promise<CaseHeader | null> {
  const [c, p, v] = await Promise.all([
    supabase.from('cases').select('policy_no, incident_date, suspicion_summary').eq('id', caseId).maybeSingle(),
    supabase.from('parties').select('role, name, phone, address').eq('case_id', caseId),
    supabase.from('case_field_values').select('field_id, value').eq('case_id', caseId),
  ]);
  if (c.error || !c.data) return null;
  return {
    ...base,
    policy_no: c.data.policy_no ?? null,
    incident_date: c.data.incident_date ?? null,
    suspicion_summary: c.data.suspicion_summary ?? null,
    parties: (p.data ?? []).map((r) => ({ role: String(r.role), name: r.name, phone: r.phone ?? null, address: r.address ?? null })),
    intake_values: (v.data ?? []).map((r) => ({ field_id: String(r.field_id), value: r.value ?? null })),
  };
}

export async function fetchChecklist(caseId: string): Promise<ChecklistRow[] | null> {
  const [list, cats] = await Promise.all([
    supabase.from('v_case_checklist').select('checklist_item_id, description, category_id, status, evidence_count, position').eq('case_id', caseId).order('position'),
    supabase.from('evidence_categories').select('id, code'),
  ]);
  if (list.error) return null;
  const code = new Map((cats.data ?? []).map((c: { id: string; code: string }) => [c.id, c.code]));
  return (list.data ?? []).map((r) => ({
    checklist_item_id: String(r.checklist_item_id), description: r.description ?? '', status: String(r.status),
    evidence_count: Number(r.evidence_count ?? 0), category_code: r.category_id ? code.get(r.category_id) ?? null : null,
  }));
}

export async function fetchMessages(caseId: string): Promise<Msg[] | null> {
  const { data, error } = await supabase
    .from('case_messages')
    .select('id, kind, body, sender_id, created_at, withdrawn_at, client_message_id')
    .eq('case_id', caseId)
    .order('created_at', { ascending: false })
    .limit(MESSAGE_LIMIT);
  return error ? null : ((data ?? []) as Msg[]);
}

const PROC: readonly ProcState[] = ['none', 'pending', 'processing', 'failed', 'done'];

/**
 * Files of the thread's messages (evidence under RLS: own files and files of visible office messages; never
 * staff-only ones), the copy widths the caller can read (p_derivatives_field_r) and the processing state for ✓✓.
 * Plus the office's last read time for blue ✓✓ (case_thread_state). Null when the evidence read fails.
 */
export async function fetchThreadFiles(caseId: string): Promise<ThreadFiles | null> {
  const [ev, proc, st] = await Promise.all([
    supabase
      .from('evidence')
      .select('id, message_id, evidence_type, mime_type, size_bytes, original_filename, sha256, withdrawn_at, evidence_derivatives(width)')
      .eq('case_id', caseId)
      .not('message_id', 'is', null)
      .is('withdrawn_at', null)
      .order('created_at', { ascending: true })
      .limit(1000),
    supabase.from('v_evidence_processing').select('evidence_id, state').eq('case_id', caseId).limit(2000),
    supabase.rpc('case_thread_state', { p_case_id: caseId }),
  ]);
  if (ev.error) return null;
  const state = new Map<string, ProcState>();
  for (const r of (proc.data ?? []) as { evidence_id: string; state: string }[]) {
    state.set(String(r.evidence_id), (PROC as readonly string[]).includes(r.state) ? (r.state as ProcState) : 'none');
  }
  type Row = {
    id: string; message_id: string; evidence_type: string; mime_type: string | null; size_bytes: number | null;
    original_filename: string | null; sha256: string | null; evidence_derivatives: { width: number }[] | null;
  };
  const files: ServerFile[] = ((ev.data ?? []) as unknown as Row[]).map((r) => ({
    id: String(r.id),
    message_id: String(r.message_id),
    evidence_type: String(r.evidence_type),
    mime_type: r.mime_type ?? null,
    size_bytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
    original_filename: r.original_filename ?? null,
    sha256: r.sha256 ?? null,
    copies: (r.evidence_derivatives ?? []).map((d) => Number(d.width)).sort((a, b) => a - b),
    processing: state.get(String(r.id)) ?? 'none',
  }));
  const row = Array.isArray(st.data) ? (st.data[0] as { staff_last_read_at?: string | null } | undefined) : undefined;
  return { files, staff_last_read_at: row?.staff_last_read_at ?? null };
}

/** mark_thread_read(p_case_id): the thread is on screen (gap 9). Best effort; false when it did not go. */
export async function markThreadRead(caseId: string): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('mark_thread_read', { p_case_id: caseId });
    return !error;
  } catch {
    return false;
  }
}

/** This operator's open tasks on one case (RLS: p_tasks_field_r, own tasks only). */
export async function fetchCaseOpenTasks(caseId: string): Promise<OpenTaskRow[] | null> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, status, created_at')
    .eq('case_id', caseId)
    .in('status', ['pending', 'in_progress']);
  if (error) return null;
  return (data ?? []).map((t) => ({ id: String(t.id), title: String(t.title), status: String(t.status), created_at: String(t.created_at) }));
}

/** complete_field_task(p_task_id): online only, never queued (docs/11 "Mark task done"). Null = done. */
export async function completeTask(taskId: string): Promise<RpcErrorLike | null> {
  try {
    const { error } = await supabase.rpc('complete_field_task', { p_task_id: taskId });
    return error ? { code: error.code, message: error.message } : null;
  } catch (e) {
    return { code: null, message: e instanceof Error ? e.message : 'Network request failed' };
  }
}
