// Shared shapes of the pipeline worker. Rows mirror the tables in supabase/migrations (see docs/10).

export type Stage = 'text_extract' | 'label' | 'ocr' | 'field_suggest';
export const STAGES: Stage[] = ['text_extract', 'label', 'ocr', 'field_suggest'];

export type FinalStatus = 'done' | 'skipped' | 'failed';

/** A row of public.processing_jobs as returned by claim_processing_jobs(). */
export interface Job {
  id: number;
  evidence_id: string;
  stage: Stage;
  status: string;
  attempts: number;
  max_attempts: number;
  pipeline_version: string;
  locked_by: string | null;
  locked_at: string | null;
}

export interface Evidence {
  id: string;
  case_id: string;
  evidence_type: 'photo' | 'video' | 'audio' | 'document' | 'note' | string;
  mime_type: string | null;
  storage_backend: 'r2' | 'supabase' | string;
  storage_path: string | null;
  sha256: string;
  size_bytes: number | null;
  withdrawn_at: string | null;
  template_id: string | null;          // the case's template version
}

export interface Derivative {
  evidence_id: string;
  width: number;
  storage_path: string;
  sha256: string;
  pixel_width: number | null;
  pixel_height: number | null;
}

export interface CategoryRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  needs_ocr: boolean;
}

export interface TemplateSectionRow { id: string; key: string; title: string; position: number }
export interface TemplateFieldRow {
  id: string;
  section_id: string;
  key: string;
  label: string;
  field_type: string;
  help_text: string | null;
  position: number;
}
export interface SectionCategoryRow { section_id: string; category_id: string; position: number }

export interface TemplateRows {
  sections: TemplateSectionRow[];
  fields: TemplateFieldRow[];
  sectionCategories: SectionCategoryRow[];
}

export interface ActiveLabel { category_id: string; source: string; needs_detail: boolean | null }

/** evidence_ocr.blocks item (docs/10 "Data shapes"). */
export interface OcrBlock { text: string; bbox: [number, number, number, number]; conf: number; line: number }

export interface OcrRow {
  id: string;
  page_no: number;
  engine: string;
  text: string;
  blocks: OcrBlock[];
  mean_confidence: number | null;
}

export interface NewOcrRow {
  evidence_id: string;
  page_no: number;
  engine: string;
  engine_version: string | null;
  lang: string | null;
  text: string;
  blocks: OcrBlock[];
  mean_confidence: number | null;
}

/** One LLM answer as record_llm_labels() takes it. */
export interface LabelResult {
  pipeline_version: string;
  model: string;                       // provider/model-id
  labels: Array<{ code: string; confidence: number }>;
  fields: Array<{ key: string; confidence: number }>;
  needs_detail: boolean;
  detail_reason: string | null;
  description: string | null;
}

export interface RecordLabelsOutcome { labels: number; superseded: number; field_matches: number; held_for_review: boolean }

export interface SuggestionRow {
  ocr_id: string;
  field_key: string;
  value: string;
  confidence: number;
  block_index: number | null;          // null when the OCR row has text but no blocks
}

/** What a stage handler decides for its job. `reason` is short, machine-readable and free of personal data. */
export interface StageOutcome { status: FinalStatus; reason?: string }
