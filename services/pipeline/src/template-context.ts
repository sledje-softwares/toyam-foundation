// Per template version: the labeller's system prompt (byte-stable, so the provider's prompt cache stays warm),
// the allowed category codes and field keys, and the field / section maps the later stages need.
// Template versions never change once loaded (rule 8: a change is a new version), so the cache only expires
// to pick up category edits (load_evidence_categories).
import { buildSystemPrompt } from '../../labeller/src/prompt.ts';
import type { LabelCategory, LabelTemplate } from '../../labeller/src/prompt.ts';
import type { PipelineDb } from './db.ts';
import type { CategoryRow, TemplateFieldRow } from './types.ts';

export interface TemplateField {
  id: string;
  key: string;
  label: string;
  field_type: string;
  section_key: string;
}

export interface TemplateContext {
  templateId: string | null;
  system: string;
  codes: Set<string>;
  fieldKeys: Set<string>;
  categories: CategoryRow[];
  categoryById: Map<string, CategoryRow>;
  fields: TemplateField[];
  fieldById: Map<string, TemplateField>;
  /** category id -> keys of the fields in sections that list that category */
  fieldsByCategory: Map<string, string[]>;
  template: LabelTemplate | undefined;
}

export function buildContext(templateId: string | null, categories: CategoryRow[],
                             rows: { sections: Array<{ id: string; key: string; title: string; position: number }>;
                                     fields: TemplateFieldRow[];
                                     sectionCategories: Array<{ section_id: string; category_id: string; position: number }> } | null): TemplateContext {
  const cats = [...categories].sort((a, b) => a.code.localeCompare(b.code));
  const categoryById = new Map(cats.map((c) => [c.id, c]));
  const labelCats: LabelCategory[] = cats.map((c) => ({ code: c.code, name: c.name, ...(c.description ? { description: c.description } : {}) }));
  const sections = [...(rows?.sections ?? [])].sort((a, b) => a.position - b.position);
  const sectionKey = new Map(sections.map((s) => [s.id, s.key]));
  const fieldsSorted = [...(rows?.fields ?? [])].sort((a, b) => a.position - b.position);
  const fields: TemplateField[] = fieldsSorted.map((f) => ({
    id: f.id, key: f.key, label: f.label, field_type: f.field_type, section_key: sectionKey.get(f.section_id) ?? '',
  }));
  const template: LabelTemplate | undefined = rows ? {
    sections: sections.map((s) => ({
      key: s.key,
      title: s.title,
      categories: (rows.sectionCategories ?? []).filter((x) => x.section_id === s.id).sort((a, b) => a.position - b.position)
        .map((x) => categoryById.get(x.category_id)?.code).filter((c): c is string => !!c),
      fields: fieldsSorted.filter((f) => f.section_id === s.id)
        .map((f) => ({ key: f.key, label: f.label, ...(f.help_text ? { help: f.help_text } : {}) })),
    })),
  } : undefined;
  const fieldsByCategory = new Map<string, string[]>();
  for (const sc of rows?.sectionCategories ?? []) {
    const keys = fieldsSorted.filter((f) => f.section_id === sc.section_id).map((f) => f.key);
    fieldsByCategory.set(sc.category_id, [...new Set([...(fieldsByCategory.get(sc.category_id) ?? []), ...keys])]);
  }
  return {
    templateId,
    system: buildSystemPrompt(labelCats, template),
    codes: new Set(cats.map((c) => c.code)),
    fieldKeys: new Set(fields.map((f) => f.key)),
    categories: cats,
    categoryById,
    fields,
    fieldById: new Map(fields.map((f) => [f.id, f])),
    fieldsByCategory,
    template,
  };
}

export class TemplateCache {
  db: PipelineDb;
  ttlMs: number;
  now: () => number;
  entries: Map<string, { at: number; ctx: Promise<TemplateContext> }>;
  maxEntries: number;

  constructor(db: PipelineDb, opts: { ttlMs?: number; now?: () => number; maxEntries?: number } = {}) {
    this.db = db;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.entries = new Map();
    this.maxEntries = opts.maxEntries ?? 50;
  }

  get(templateId: string | null): Promise<TemplateContext> {
    const k = templateId ?? '-';
    const hit = this.entries.get(k);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.ctx;
    const ctx = (async () => {
      const [cats, rows] = await Promise.all([this.db.getCategories(), templateId ? this.db.getTemplate(templateId) : Promise.resolve(null)]);
      return buildContext(templateId, cats, rows);
    })();
    ctx.catch(() => this.entries.delete(k));
    this.entries.set(k, { at: this.now(), ctx });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
    return ctx;
  }
}
