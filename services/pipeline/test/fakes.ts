// In-memory fakes for the database gateway, the object store and the label models.
import { createHash } from 'node:crypto';
import type { PipelineDb, RunningJob } from '../src/db.ts';
import type { ObjectStore } from '../src/storage.ts';
import type { LabelModel, LabelReply, LabelRequest } from '../src/models.ts';
import type { ImageResizer, PdfTools } from '../src/media.ts';
import type {
  ActiveLabel, CategoryRow, Derivative, Evidence, FinalStatus, Job, LabelResult, NewOcrRow, OcrRow, Stage, SuggestionRow, TemplateRows,
} from '../src/types.ts';

export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export const CATEGORIES: CategoryRow[] = [
  { id: 'c-vehicle', code: 'vehicle_photo', name: 'Vehicle photo', description: 'Any view of the vehicle', needs_ocr: false },
  { id: 'c-odo', code: 'odometer_photo', name: 'Odometer photo', description: null, needs_ocr: true },
  { id: 'c-dl', code: 'dl_document', name: 'Driving licence', description: null, needs_ocr: true },
  { id: 'c-rc', code: 'rc_document', name: 'RC', description: null, needs_ocr: true },
  { id: 'c-other', code: 'other', name: 'Other', description: null, needs_ocr: false },
];

export const TEMPLATE: TemplateRows = {
  sections: [
    { id: 's-driver', key: 'driver', title: 'Driver', position: 1 },
    { id: 's-reg', key: 'registration', title: 'Registration', position: 2 },
    { id: 's-garage', key: 'garage', title: 'Garage', position: 3 },
  ],
  fields: [
    { id: 'f-dl', section_id: 's-driver', key: 'dl_number', label: 'DL number of the driver', field_type: 'text', help_text: null, position: 1 },
    { id: 'f-dob', section_id: 's-driver', key: 'driver_dob', label: 'Driver DOB as per DL', field_type: 'date', help_text: null, position: 2 },
    { id: 'f-reg', section_id: 's-reg', key: 'reg_number', label: 'Registration number', field_type: 'text', help_text: null, position: 3 },
    { id: 'f-chassis', section_id: 's-reg', key: 'chassis_no', label: 'Chassis number', field_type: 'text', help_text: null, position: 4 },
    { id: 'f-odo', section_id: 's-garage', key: 'odometer_at_entry', label: 'Odometer reading at entry', field_type: 'text', help_text: 'From the photo', position: 5 },
  ],
  sectionCategories: [
    { section_id: 's-driver', category_id: 'c-dl', position: 1 },
    { section_id: 's-reg', category_id: 'c-rc', position: 1 },
    { section_id: 's-garage', category_id: 'c-odo', position: 1 },
  ],
};

export function job(over: Partial<Job> = {}): Job {
  return { id: 1, evidence_id: 'e1', stage: 'label', status: 'running', attempts: 1, max_attempts: 5, pipeline_version: 'v1', locked_by: 'w', locked_at: null, ...over };
}

export function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    id: 'e1', case_id: 'case1', evidence_type: 'photo', mime_type: 'image/jpeg', storage_backend: 'r2',
    storage_path: 'cases/case1/tasks/t1/orig.jpg', sha256: sha('original'), size_bytes: 8, withdrawn_at: null, template_id: 'tpl1', ...over,
  };
}

export class FakeDb implements PipelineDb {
  evidence = new Map<string, Evidence>();
  derivatives = new Map<string, Derivative>();
  categories: CategoryRow[] = CATEGORIES;
  template: TemplateRows = TEMPLATE;
  labels: Array<ActiveLabel & { evidence_id: string; is_active: boolean; model: string | null; version: string | null }> = [];
  matches: Array<{ evidence_id: string; field_id: string; score: number }> = [];
  ocr: Array<OcrRow & { evidence_id: string; is_current: boolean }> = [];
  wanted = new Map<string, boolean>();
  recorded: Array<{ evidenceId: string; result: LabelResult; superseded: LabelResult | null }> = [];
  suggestions: Array<{ evidenceId: string; rows: SuggestionRow[] }> = [];
  enqueued: Array<{ ids: string[]; stages: Stage[]; version: string }> = [];
  completed: Array<{ id: number; status: FinalStatus; error: string | null }> = [];
  queue: Job[] = [];
  runningJobs: RunningJob[] = [];
  claimCalls: Array<{ stages: Stage[]; limit: number }> = [];
  templateLoads = 0;
  claimError: Error | null = null;

  async claimJobs(stages: Stage[], limit: number, worker: string) {
    this.claimCalls.push({ stages, limit });
    if (this.claimError) throw this.claimError;
    const out: Job[] = [];
    while (out.length < limit && this.queue.length) {
      const j = this.queue.shift() as Job;
      if (!stages.includes(j.stage)) continue;
      out.push({ ...j, status: 'running', locked_by: worker, attempts: j.attempts + 1 });
    }
    return out;
  }
  async completeJob(id: number, status: FinalStatus, error: string | null = null) {
    this.completed.push({ id, status, error });
  }
  async listRunningJobs() { return this.runningJobs; }
  async enqueueReprocessing(ids: string[], stages: Stage[], version: string) {
    this.enqueued.push({ ids, stages, version });
    return ids.length * stages.length;
  }
  async getEvidence(id: string) { return this.evidence.get(id) ?? null; }
  async getDerivative(id: string, width: number) {
    const d = this.derivatives.get(id);
    return d && d.width === width ? d : null;
  }
  async getCategories() { return this.categories; }
  async getTemplate(_id: string) {
    this.templateLoads++;
    return this.template;
  }
  async getActiveLabels(id: string) { return this.labels.filter((l) => l.evidence_id === id && l.is_active); }
  async getFieldMatches(id: string) { return this.matches.filter((m) => m.evidence_id === id); }
  async ocrWanted(id: string) { return this.wanted.get(id) ?? true; }
  async getCurrentOcr(id: string) { return this.ocr.filter((r) => r.evidence_id === id && r.is_current); }
  async insertOcr(rows: NewOcrRow[]) {
    for (const r of rows) {
      for (const o of this.ocr) if (o.evidence_id === r.evidence_id && o.page_no === r.page_no) o.is_current = false;
      this.ocr.push({ ...r, id: `ocr-${this.ocr.length + 1}`, is_current: true });
    }
  }
  async recordLlmLabels(evidenceId: string, result: LabelResult, superseded: LabelResult | null = null) {
    this.recorded.push({ evidenceId, result, superseded });
    for (const l of this.labels) if (l.evidence_id === evidenceId && l.source === 'llm') l.is_active = false;
    for (const l of result.labels) {
      const cat = this.categories.find((c) => c.code === l.code);
      this.labels.push({ evidence_id: evidenceId, category_id: cat?.id ?? l.code, source: 'llm', needs_detail: result.needs_detail, is_active: true, model: result.model, version: result.pipeline_version });
    }
    return { labels: result.labels.length, superseded: superseded?.labels.length ?? 0, field_matches: result.fields.length, held_for_review: false };
  }
  async recordFieldSuggestions(evidenceId: string, rows: SuggestionRow[]) {
    this.suggestions.push({ evidenceId, rows });
    return rows.length;
  }
}

export class FakeStore implements ObjectStore {
  objects = new Map<string, Uint8Array>();
  reads: string[] = [];
  put(backend: string, path: string, bytes: Uint8Array | string) {
    this.objects.set(`${backend}:${path}`, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  }
  async get(backend: string, path: string, opts: { maxBytes: number }) {
    this.reads.push(`${backend}:${path}`);
    const b = this.objects.get(`${backend}:${path}`);
    if (!b) throw new Error(`not found ${backend}:${path}`);
    if (b.byteLength > opts.maxBytes) throw new Error('too large');
    return b;
  }
}

export class FakeResizer implements ImageResizer {
  calls = 0;
  async toJpeg(_bytes: Uint8Array, longEdge: number) {
    this.calls++;
    return { bytes: new TextEncoder().encode('small-jpeg'), width: longEdge, height: Math.round(longEdge * 0.75) };
  }
}

export function fakePdf(pages: string[] = [], render = true): PdfTools {
  return {
    version: 'fake-pdf 1',
    async textPages(_b, maxPages) {
      return {
        pages: pages.slice(0, maxPages).map((t, i) => ({
          page_no: i + 1, text: t, blocks: t ? t.split('\n').map((line, j) => ({ text: line, bbox: [0, j * 10, 100, 10] as [number, number, number, number], conf: 1, line: j + 1 })) : [],
        })),
        pageCount: pages.length,
      };
    },
    async renderFirstPage(_b, edge) {
      return render ? { bytes: new TextEncoder().encode('page1'), width: Math.round(edge * 0.77), height: edge } : null;
    },
  };
}

/** A model that answers from a queue of texts (or throws an Error entry). */
export class FakeModel implements LabelModel {
  key: string;
  answers: Array<string | Error>;
  requests: LabelRequest[] = [];
  constructor(key: string, answers: Array<string | Error>) {
    this.key = key;
    this.answers = answers;
  }
  async label(req: LabelRequest): Promise<LabelReply> {
    this.requests.push(req);
    const a = this.answers.shift();
    if (a === undefined) throw new Error('no more answers');
    if (a instanceof Error) throw a;
    return { text: a, usage: { input: 100, cachedRead: 2000, cacheWrite: 0, output: 60 }, model: this.key, latencyMs: 5 };
  }
}

export function answer(labels: Array<[string, number]>, fields: Array<[string, number]> = [], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    labels: labels.map(([code, confidence]) => ({ code, confidence })),
    fields: fields.map(([key, confidence]) => ({ key, confidence })),
    needs_detail: true, detail_reason: 'number', description: null, ...extra,
  });
}
