// Database gateway: everything the worker reads and writes, behind one interface so the stages can be
// tested with an in-memory fake. The Supabase implementation uses the service-role key (server-side only).
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActiveLabel, CategoryRow, Derivative, Evidence, FinalStatus, Job, LabelResult, NewOcrRow, OcrRow, RecordLabelsOutcome,
  Stage, SuggestionRow, TemplateRows,
} from './types.ts';

export interface RunningJob { id: number; locked_by: string | null; locked_at: string | null }

export interface PipelineDb {
  claimJobs(stages: Stage[], limit: number, worker: string): Promise<Job[]>;
  completeJob(id: number, status: FinalStatus, error?: string | null): Promise<void>;
  listRunningJobs(): Promise<RunningJob[]>;
  enqueueReprocessing(evidenceIds: string[], stages: Stage[], pipelineVersion: string): Promise<number>;

  getEvidence(id: string): Promise<Evidence | null>;
  getDerivative(evidenceId: string, width: number): Promise<Derivative | null>;
  getCategories(): Promise<CategoryRow[]>;
  getTemplate(templateId: string): Promise<TemplateRows>;
  getActiveLabels(evidenceId: string): Promise<ActiveLabel[]>;
  getFieldMatches(evidenceId: string): Promise<Array<{ field_id: string; score: number }>>;
  ocrWanted(evidenceId: string): Promise<boolean>;
  getCurrentOcr(evidenceId: string): Promise<OcrRow[]>;

  insertOcr(rows: NewOcrRow[]): Promise<void>;
  recordLlmLabels(evidenceId: string, result: LabelResult, superseded?: LabelResult | null): Promise<RecordLabelsOutcome>;
  recordFieldSuggestions(evidenceId: string, rows: SuggestionRow[]): Promise<number>;
}

/** Error from the database; the message is PostgREST's / Postgres's (no row data). */
export class DbError extends Error {
  code: string | null;
  constructor(op: string, err: { message?: string; code?: string } | null) {
    super(`${op}: ${err?.message ?? 'unknown database error'}`);
    this.code = err?.code ?? null;
  }
}

type Res<T> = { data: T | null; error: { message?: string; code?: string } | null };

function must<T>(op: string, r: Res<T>): T {
  if (r.error) throw new DbError(op, r.error);
  return r.data as T;
}

export function createSupabaseDb(sb: SupabaseClient): PipelineDb {
  return {
    async claimJobs(stages, limit, worker) {
      const rows = must('claim_processing_jobs', await sb.rpc('claim_processing_jobs', { p_stages: stages, p_limit: limit, p_worker: worker }));
      return ((rows as Job[] | null) ?? []).map((j) => ({ ...j, id: Number(j.id) }));
    },
    async completeJob(id, status, error = null) {
      must('complete_processing_job', await sb.rpc('complete_processing_job', { p_job_id: id, p_status: status, p_error: error }));
    },
    async listRunningJobs() {
      const rows = must('processing_jobs', await sb.from('processing_jobs').select('id, locked_by, locked_at').eq('status', 'running').limit(1000));
      return ((rows as RunningJob[] | null) ?? []).map((j) => ({ ...j, id: Number(j.id) }));
    },
    async enqueueReprocessing(evidenceIds, stages, pipelineVersion) {
      return Number(must('enqueue_reprocessing', await sb.rpc('enqueue_reprocessing', {
        p_evidence_ids: evidenceIds, p_stages: stages, p_pipeline_version: pipelineVersion,
      })) ?? 0);
    },

    async getEvidence(id) {
      const row = must('evidence', await sb.from('evidence')
        .select('id, case_id, evidence_type, mime_type, storage_backend, storage_path, sha256, size_bytes, withdrawn_at, cases(template_id)')
        .eq('id', id).maybeSingle()) as (Omit<Evidence, 'template_id'> & { cases: { template_id: string | null } | null }) | null;
      if (!row) return null;
      const { cases, ...rest } = row;
      return { ...rest, template_id: cases?.template_id ?? null };
    },
    async getDerivative(evidenceId, width) {
      return must('evidence_derivatives', await sb.from('evidence_derivatives')
        .select('evidence_id, width, storage_path, sha256, pixel_width, pixel_height')
        .eq('evidence_id', evidenceId).eq('width', width).maybeSingle()) as Derivative | null;
    },
    async getCategories() {
      return (must('evidence_categories', await sb.from('evidence_categories')
        .select('id, code, name, description, needs_ocr').eq('is_active', true).order('code')) as CategoryRow[] | null) ?? [];
    },
    async getTemplate(templateId) {
      const [s, f] = await Promise.all([
        sb.from('case_template_sections').select('id, key, title, position').eq('template_id', templateId).order('position'),
        sb.from('case_template_fields').select('id, section_id, key, label, field_type, help_text, position')
          .eq('template_id', templateId).order('position'),
      ]);
      const sections = (must('case_template_sections', s) as TemplateRows['sections'] | null) ?? [];
      const fields = (must('case_template_fields', f) as TemplateRows['fields'] | null) ?? [];
      const sectionCategories = sections.length
        ? (must('case_template_section_categories', await sb.from('case_template_section_categories')
            .select('section_id, category_id, position').in('section_id', sections.map((x) => x.id))) as TemplateRows['sectionCategories'] | null) ?? []
        : [];
      return { sections, fields, sectionCategories };
    },
    async getActiveLabels(evidenceId) {
      return (must('evidence_labels', await sb.from('evidence_labels').select('category_id, source, needs_detail')
        .eq('evidence_id', evidenceId).eq('is_active', true)) as ActiveLabel[] | null) ?? [];
    },
    async getFieldMatches(evidenceId) {
      return (must('evidence_field_matches', await sb.from('evidence_field_matches').select('field_id, score')
        .eq('evidence_id', evidenceId)) as Array<{ field_id: string; score: number }> | null) ?? [];
    },
    async ocrWanted(evidenceId) {
      return must('ocr_wanted', await sb.rpc('ocr_wanted', { p_evidence_id: evidenceId })) === true;
    },
    async getCurrentOcr(evidenceId) {
      return (must('evidence_ocr', await sb.from('evidence_ocr').select('id, page_no, engine, text, blocks, mean_confidence')
        .eq('evidence_id', evidenceId).eq('is_current', true).order('page_no')) as OcrRow[] | null) ?? [];
    },

    async insertOcr(rows) {
      if (rows.length === 0) return;
      must('evidence_ocr insert', await sb.from('evidence_ocr').insert(rows));
    },
    async recordLlmLabels(evidenceId, result, superseded = null) {
      return must('record_llm_labels', await sb.rpc('record_llm_labels', {
        p_evidence_id: evidenceId, p_result: result, p_superseded: superseded,
      })) as RecordLabelsOutcome;
    },
    async recordFieldSuggestions(evidenceId, rows) {
      return Number(must('record_field_suggestions', await sb.rpc('record_field_suggestions', { p_evidence_id: evidenceId, p_rows: rows })) ?? 0);
    },
  };
}
