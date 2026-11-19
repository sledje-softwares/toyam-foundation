// config/templates/*.yaml → JSON for public.load_case_template(), and → IntakeTemplate for tests.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { parse } from 'yaml';
import type { IntakeConfig, IntakeTemplate } from '../../../supabase/functions/_shared/intake/types.ts';
import { imageSize, sniffImage, toBase64 } from '../../../supabase/functions/_shared/report/image.ts';
import { templateInfo, validateLayout } from '../../../supabase/functions/_shared/report/validate.ts';

export interface TemplateYaml {
  insurer_code: string;
  claim_type: string;
  variant?: string;
  name: string;
  intake_rules?: Record<string, unknown>;
  sections: Array<{
    key: string;
    title: string;
    categories?: string[];
    fields?: Array<{ key: string; label: string; type?: string; source?: string; required?: boolean; extract?: Record<string, unknown> }>;
  }>;
  [k: string]: unknown;
}

export const TEMPLATES_DIR = new URL('../../../config/templates/', import.meta.url).pathname;

export function readYaml<T>(path: string): T {
  return parse(readFileSync(path, 'utf8')) as T;
}

export function templateFiles(dir = TEMPLATES_DIR): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).sort().map((f) => join(dir, f));
}

/** Static checks before loading: unique keys, known categories, valid regexes. */
export function validateTemplate(t: TemplateYaml, categoryCodes: Set<string>): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  const sections = new Set<string>();
  for (const s of t.sections ?? []) {
    if (sections.has(s.key)) errors.push(`duplicate section key ${s.key}`);
    sections.add(s.key);
    for (const c of s.categories ?? []) if (!categoryCodes.has(c)) errors.push(`unknown category ${c} in ${s.key}`);
    for (const f of s.fields ?? []) {
      if (keys.has(f.key)) errors.push(`duplicate field key ${f.key}`);
      keys.add(f.key);
      const re = (f.extract as { regex?: string } | undefined)?.regex;
      if (re) try { new RegExp(re, 'i'); } catch { errors.push(`bad regex in ${f.key}`); }
    }
  }
  const p = (t.intake_rules as { subject_pattern?: string } | undefined)?.subject_pattern;
  if (p) try { new RegExp(p, 'i'); } catch { errors.push('bad subject_pattern'); }
  if (!keys.has('insurer_claim_no')) errors.push('template needs an insurer_claim_no field');
  return errors;
}

/** Shape returned by public.intake_config() for one template (ids supplied by the caller). */
export function toIntakeTemplate(t: TemplateYaml, ids: { id: string; insurer_id: string; version?: number }): IntakeTemplate {
  const fields = [];
  for (const s of t.sections) {
    for (const f of s.fields ?? []) {
      if ((f.source ?? 'office') !== 'intake') continue;
      fields.push({
        key: f.key,
        label: f.label,
        type: f.type ?? 'text',
        required: !!f.required,
        extract: (f.extract ?? {}) as IntakeTemplate['fields'][number]['extract'],
      });
    }
  }
  return {
    id: ids.id,
    insurer_id: ids.insurer_id,
    insurer_code: t.insurer_code,
    claim_type: t.claim_type,
    variant: t.variant ?? 'general',
    version: ids.version ?? 1,
    intake_rules: (t.intake_rules ?? {}) as IntakeTemplate['intake_rules'],
    fields,
  };
}

/** Test/dev config built from the YAML files (insurer ids = codes). */
export function configFromYaml(extra?: Partial<IntakeConfig>): IntakeConfig {
  const templates: IntakeTemplate[] = [];
  const insurers = new Map<string, { id: string; code: string; name: string; domains: string[] }>();
  for (const file of templateFiles()) {
    const t = readYaml<TemplateYaml>(file);
    const domains = ((t.intake_rules as { sender_domains?: string[] })?.sender_domains) ?? [];
    const ins = insurers.get(t.insurer_code) ?? { id: `ins-${t.insurer_code}`, code: t.insurer_code, name: t.insurer_code, domains: [] };
    for (const d of domains) if (!ins.domains.includes(d)) ins.domains.push(d);
    insurers.set(t.insurer_code, ins);
    templates.push(toIntakeTemplate(t, { id: `tpl-${t.insurer_code}-${t.claim_type}-${t.variant ?? 'general'}`, insurer_id: ins.id }));
  }
  return {
    internal_domains: ['toyaminvestigation.in'],
    internal_addresses: ['toyaminvestigation@gmail.com'],
    insurers: [...insurers.values()],
    templates,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Report layouts (D51, docs/13-report-layouts.md). A template names its layout file:
//   report_layout: layouts/icl-motor-od.yaml        (relative to the template file)
// Asset files in the layout (`assets: {letterhead: {file: assets/letterhead.png}}`, relative to the layout file)
// are embedded as base64 with their pixel size. The resolved layout travels inside the template JSON, so a layout
// change makes a new template version (cases keep theirs).

function safeRelative(base: string, rel: unknown, what: string): string {
  if (typeof rel !== 'string' || rel === '' || isAbsolute(rel) || normalize(rel).split(/[\\/]/).includes('..')) {
    throw new Error(`${what} must be a relative path inside config/templates (got ${JSON.stringify(rel)})`);
  }
  return join(base, rel);
}

/** Reads a layout object's `{file: …}` assets and embeds them. Returns errors instead of throwing. */
export function embedLayoutAssets(layout: unknown, baseDir: string): string[] {
  const errors: string[] = [];
  const assets = (layout as { assets?: Record<string, unknown> } | null)?.assets;
  if (!assets || typeof assets !== 'object') return errors;
  for (const [name, a] of Object.entries(assets)) {
    if (!a || typeof a !== 'object' || !('file' in a)) continue;
    try {
      const keys = Object.keys(a);
      if (keys.length !== 1) throw new Error('a file asset has only the key file');
      const path = safeRelative(baseDir, (a as { file: unknown }).file, `assets.${name}.file`);
      const bytes = new Uint8Array(readFileSync(path));
      const mime = sniffImage(bytes);
      const size = imageSize(bytes);
      if (!mime || !size) throw new Error(`${path} is not a readable JPEG or PNG`);
      assets[name] = { mime, width: size.width, height: size.height, data_base64: toBase64(bytes) };
    } catch (e) {
      errors.push(`$.assets.${name}: ${(e as Error).message}`);
    }
  }
  return errors;
}

/**
 * Resolves `report_layout` of a template (a file name, or an inline object), embeds assets and validates it against
 * the template's fields and sections. Returns the config with the layout object in place, plus errors.
 */
export function resolveTemplateLayout(t: TemplateYaml, templateFile: string): { config: TemplateYaml; errors: string[] } {
  const ref = t.report_layout;
  if (ref === undefined || ref === null) return { config: t, errors: [] };
  let layout: unknown;
  let baseDir = dirname(templateFile);
  const errors: string[] = [];
  try {
    if (typeof ref === 'string') {
      const path = safeRelative(baseDir, ref, 'report_layout');
      layout = readYaml<unknown>(path);
      baseDir = dirname(path);
    } else layout = structuredClone(ref);
  } catch (e) {
    return { config: t, errors: [`report_layout: ${(e as Error).message}`] };
  }
  errors.push(...embedLayoutAssets(layout, baseDir));
  if (errors.length === 0) {
    errors.push(...validateLayout(layout, templateInfo(t.sections ?? [])));
  }
  return { config: { ...t, report_layout: layout }, errors: errors.map((e) => `report_layout ${e}`) };
}

// ---------------------------------------------------------------------------------------------
// Category → field map (docs/09-template-model.md "Category → field map", docs/14 gap 26). A template names its map:
//   category_map: maps/icl-motor-od.yaml            (relative to the template file)
// The map file holds `categories: {<category code>: {<field key>: score}}` plus review metadata (`generated_by`,
// `reviewed`, `unmapped_fields`). Only the scores travel to the database, as `category_fields` in the template JSON
// (load_case_template() stores them in case_template_category_fields), so the scores are covered by config_sha256
// (a score change is a new template version) while flipping `reviewed` is not.

export interface CategoryMapFile {
  generated_by?: string;
  reviewed?: boolean;
  categories?: Record<string, Record<string, number> | null>;
  unmapped_fields?: string[];
}

export type CategoryFields = Record<string, Record<string, number>>;

export interface CategoryMapReport {
  /** Validation errors (unknown category / field, bad score): the load fails. */
  errors: string[];
  /** Template categories (and all others) that the map does not list at all: not reviewed yet. */
  missingCategories: string[];
  /** Categories listed with `{}`: reviewed, evidence for no field. */
  emptyCategories: string[];
  /** Fields no category maps to and not listed in unmapped_fields: not reviewed yet. */
  unreviewedFields: string[];
  /** Fields listed in unmapped_fields. */
  acceptedUnmappedFields: string[];
  pairs: number;
}

export function templateFieldKeys(t: TemplateYaml): string[] {
  return (t.sections ?? []).flatMap((s) => (s.fields ?? []).map((f) => f.key));
}

/** Validates a map file against the template's fields and the category codes; pure. */
export function checkCategoryMap(map: CategoryMapFile, t: TemplateYaml, categoryCodes: Iterable<string>): CategoryMapReport {
  const codes = [...categoryCodes];
  const known = new Set(codes);
  const fields = templateFieldKeys(t);
  const fieldSet = new Set(fields);
  const errors: string[] = [];
  const mapped = new Set<string>();
  const cats = map.categories ?? {};
  let pairs = 0;
  if (typeof cats !== 'object' || Array.isArray(cats)) errors.push('categories must be a map of category code → {field: score}');
  const emptyCategories: string[] = [];
  for (const [code, entry] of Object.entries(cats ?? {})) {
    if (!known.has(code)) errors.push(`unknown category ${code}`);
    if (entry === null || (typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 0)) {
      emptyCategories.push(code);
      continue;
    }
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${code}: must be a map of field key → score`);
      continue;
    }
    for (const [key, score] of Object.entries(entry)) {
      if (!fieldSet.has(key)) errors.push(`${code}: unknown field ${key}`);
      if (typeof score !== 'number' || !(score > 0 && score <= 1)) errors.push(`${code}.${key}: score must be a number in (0, 1]`);
      mapped.add(key);
      pairs += 1;
    }
  }
  const accepted = map.unmapped_fields ?? [];
  if (!Array.isArray(accepted)) errors.push('unmapped_fields must be a list of field keys');
  const acceptedSet = new Set(Array.isArray(accepted) ? accepted : []);
  for (const key of acceptedSet) {
    if (!fieldSet.has(key)) errors.push(`unmapped_fields: unknown field ${key}`);
    else if (mapped.has(key)) errors.push(`unmapped_fields: ${key} is mapped by a category`);
  }
  return {
    errors,
    missingCategories: codes.filter((c) => !(c in (cats ?? {}))),
    emptyCategories,
    unreviewedFields: fields.filter((k) => !mapped.has(k) && !acceptedSet.has(k)),
    acceptedUnmappedFields: fields.filter((k) => acceptedSet.has(k)),
    pairs,
  };
}

/** Only the non-empty scores, in file order: what load_case_template() receives as `category_fields`. */
export function categoryFieldsOf(map: CategoryMapFile): CategoryFields {
  const out: CategoryFields = {};
  for (const [code, entry] of Object.entries(map.categories ?? {})) {
    if (entry && typeof entry === 'object' && Object.keys(entry).length) out[code] = { ...entry };
  }
  return out;
}

/** Reads the map file named by `category_map`. Throws on a bad path or unreadable YAML. */
export function readCategoryMap(t: TemplateYaml, templateFile: string): CategoryMapFile | null {
  const ref = t.category_map;
  if (ref === undefined || ref === null) return null;
  const path = safeRelative(dirname(templateFile), ref, 'category_map');
  return readYaml<CategoryMapFile>(path) ?? {};
}

/**
 * Resolves `category_map` of a template: validates the map against the template and the categories and replaces
 * the file reference by `category_fields` (scores only). Returns the config plus errors.
 */
export function resolveCategoryMap(
  t: TemplateYaml, templateFile: string, categoryCodes: Iterable<string>,
): { config: TemplateYaml; errors: string[] } {
  if (t.category_map === undefined || t.category_map === null) return { config: t, errors: [] };
  let map: CategoryMapFile | null;
  try {
    map = readCategoryMap(t, templateFile);
  } catch (e) {
    return { config: t, errors: [`category_map: ${(e as Error).message}`] };
  }
  const report = checkCategoryMap(map ?? {}, t, categoryCodes);
  const { category_map: _ref, ...rest } = t;
  return {
    config: { ...rest, category_fields: categoryFieldsOf(map ?? {}) },
    errors: report.errors.map((e) => `category_map ${e}`),
  };
}

/** Both resolvers in the order the loaders use (layout, then map). */
export function resolveTemplate(
  t: TemplateYaml, templateFile: string, categoryCodes: Iterable<string>,
): { config: TemplateYaml; errors: string[] } {
  const a = resolveTemplateLayout(t, templateFile);
  const b = resolveCategoryMap(a.config, templateFile, categoryCodes);
  return { config: b.config, errors: [...a.errors, ...b.errors] };
}
