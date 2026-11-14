// Bake-off scoring: labels against office ground truth, the "needs detail" flag, confidence
// routing, cost and latency. Pure functions; no npm imports.
import type { LabelAnswer } from './prompt.ts';

export interface TruthRow {
  file: string;
  codes: string[];                // correct categories (one or more)
  needs_detail: boolean | null;   // null = not marked
  fields: string[] | null;        // report fields the image is evidence for; [] = none; null = not marked
}

export interface RunRecord {
  file: string;
  answer: LabelAnswer | null;     // null when the call failed
  error?: string;
  cost: number | null;            // USD
  latencyMs: number;
}

export interface PassMarks {
  documents: number;              // top-label accuracy on files whose truth is a document category
  photos: number;
  detailRecall: number;           // share of "needs detail" files the model flagged
}

export const DEFAULT_PASS_MARKS: PassMarks = { documents: 0.95, photos: 0.90, detailRecall: 0.97 };
export const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9];

export interface CategoryScore {
  code: string;
  support: number;                // files whose truth includes the category
  recall: number | null;          // of those, share where the model gave it as any label
  precision: number | null;       // of files whose top label is the category, share where it is correct
}

export interface Summary {
  model: string;
  files: number;
  failed: number;                 // API errors and unusable answers
  accuracy: number | null;        // top label is one of the truth codes
  documentAccuracy: number | null;
  photoAccuracy: number | null;
  detail: { flaggedRight: number; missed: number; extra: number; recall: number | null; precision: number | null };
  fields: { files: number; precision: number | null; recall: number | null; topHit: number | null } | null;
  descriptionRate: number | null; // share of usable answers that carry a description
  routing: Array<{ threshold: number; coverage: number; accuracy: number | null }>;
  categories: CategoryScore[];
  confusions: Array<{ truth: string; predicted: string; count: number }>;
  cost: { total: number | null; perImage: number | null; perMonth90k: number | null; perCase300: number | null };
  latency: { p50: number | null; p95: number | null };
  pass: { documents: boolean | null; photos: boolean | null; detailRecall: boolean | null; overall: boolean | null };
}

/**
 * @param documentCodes categories whose files are documents (default_evidence_type = document)
 */
export function summarise(model: string, records: RunRecord[], truth: Map<string, TruthRow>, documentCodes: Set<string>,
                          marks: PassMarks = DEFAULT_PASS_MARKS): Summary {
  const scored = records.filter((r) => truth.has(r.file));
  const usable = scored.filter((r) => r.answer?.ok);
  const isRight = (r: RunRecord) => truth.get(r.file)!.codes.includes(r.answer!.labels[0].code);
  // A failed call counts as wrong: the file would have needed a person.
  const accuracyOf = (rs: RunRecord[]) => (rs.length ? rs.filter((r) => r.answer?.ok && isRight(r)).length / rs.length : null);

  const docs = scored.filter((r) => truth.get(r.file)!.codes.some((c) => documentCodes.has(c)));
  const photos = scored.filter((r) => !truth.get(r.file)!.codes.some((c) => documentCodes.has(c)));

  // needs_detail against marked truth; a failed call is treated as "flagged" (the pipeline would run OCR)
  let flaggedRight = 0, missed = 0, extra = 0, predictedTrue = 0;
  for (const r of scored) {
    const t = truth.get(r.file)!.needs_detail;
    if (t === null) continue;
    const p = r.answer ? r.answer.needs_detail : true;
    if (p) predictedTrue++;
    if (t && p) flaggedRight++;
    else if (t && !p) missed++;
    else if (!t && p) extra++;
  }
  const detailRecall = flaggedRight + missed ? flaggedRight / (flaggedRight + missed) : null;
  const detailPrecision = predictedTrue ? flaggedRight / predictedTrue : null;

  // Field matches (D35), micro-averaged over files whose fields are marked. A failed call matches nothing.
  const withFields = scored.filter((r) => truth.get(r.file)!.fields !== null);
  let tp = 0, predicted = 0, actual = 0, topHits = 0, topTotal = 0;
  for (const r of withFields) {
    const t = new Set(truth.get(r.file)!.fields!);
    const p = r.answer?.ok ? r.answer.fields.map((f) => f.key) : [];
    predicted += p.length;
    actual += t.size;
    tp += p.filter((k) => t.has(k)).length;
    if (t.size) {
      topTotal++;
      if (p.length && t.has(p[0])) topHits++;
    }
  }
  const fields = withFields.length
    ? { files: withFields.length, precision: predicted ? tp / predicted : null, recall: actual ? tp / actual : null, topHit: topTotal ? topHits / topTotal : null }
    : null;
  const descriptionRate = usable.length ? usable.filter((r) => r.answer!.description).length / usable.length : null;

  const routing = THRESHOLDS.map((threshold) => {
    const covered = usable.filter((r) => r.answer!.labels[0].confidence >= threshold);
    return { threshold, coverage: scored.length ? covered.length / scored.length : 0, accuracy: accuracyOf(covered) };
  });

  const codes = new Set<string>();
  for (const r of scored) for (const c of truth.get(r.file)!.codes) codes.add(c);
  for (const r of usable) codes.add(r.answer!.labels[0].code);
  const categories: CategoryScore[] = [...codes].sort().map((code) => {
    const withTruth = scored.filter((r) => truth.get(r.file)!.codes.includes(code));
    const topIs = usable.filter((r) => r.answer!.labels[0].code === code);
    return {
      code,
      support: withTruth.length,
      recall: withTruth.length ? withTruth.filter((r) => r.answer?.labels.some((l) => l.code === code)).length / withTruth.length : null,
      precision: topIs.length ? topIs.filter((r) => truth.get(r.file)!.codes.includes(code)).length / topIs.length : null,
    };
  });

  const confusionCount = new Map<string, number>();
  for (const r of usable) {
    if (isRight(r)) continue;
    const key = `${truth.get(r.file)!.codes[0]}\u0000${r.answer!.labels[0].code}`;
    confusionCount.set(key, (confusionCount.get(key) ?? 0) + 1);
  }
  const confusions = [...confusionCount].map(([k, count]) => {
    const [t, p] = k.split('\u0000');
    return { truth: t, predicted: p, count };
  }).sort((a, b) => b.count - a.count).slice(0, 10);

  const costs = records.map((r) => r.cost);
  const total = costs.every((c) => c !== null) && costs.length ? (costs as number[]).reduce((a, b) => a + b, 0) : null;
  const perImage = total !== null && records.length ? total / records.length : null;

  const lat = records.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);

  const accuracy = accuracyOf(scored);
  const documentAccuracy = accuracyOf(docs);
  const photoAccuracy = accuracyOf(photos);
  const pass = {
    documents: documentAccuracy === null ? null : documentAccuracy >= marks.documents,
    photos: photoAccuracy === null ? null : photoAccuracy >= marks.photos,
    detailRecall: detailRecall === null ? null : detailRecall >= marks.detailRecall,
    overall: null as boolean | null,
  };
  const known = [pass.documents, pass.photos, pass.detailRecall].filter((v) => v !== null);
  pass.overall = known.length ? known.every(Boolean) : null;

  return {
    model,
    files: scored.length,
    failed: scored.length - usable.length,
    accuracy,
    documentAccuracy,
    photoAccuracy,
    detail: { flaggedRight, missed, extra, recall: detailRecall, precision: detailPrecision },
    fields,
    descriptionRate,
    routing,
    categories,
    confusions,
    cost: {
      total,
      perImage,
      perMonth90k: perImage === null ? null : perImage * 90_000,
      perCase300: perImage === null ? null : perImage * 300,
    },
    latency: { p50: pct(0.5), p95: pct(0.95) },
    pass,
  };
}

const pc = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const usd = (v: number | null, digits = 2) => (v === null ? '—' : `$${v.toFixed(digits)}`);
const yes = (v: boolean | null) => (v === null ? '—' : v ? 'pass' : 'FAIL');

/** Markdown report comparing all models (no file names or descriptions: safe to share). */
export function renderMarkdown(summaries: Summary[], meta: { date: string; setup: string; promptVersion: string; marks: PassMarks }): string {
  const out: string[] = [];
  out.push(`# Labelling bake-off — ${meta.date}`, '');
  out.push(`Setup: ${meta.setup}. Prompt ${meta.promptVersion}. Pass marks: documents ≥ ${pc(meta.marks.documents)}, photos ≥ ${pc(meta.marks.photos)}, "needs detail" recall ≥ ${pc(meta.marks.detailRecall)}.`, '');
  out.push('| Model | Files | Failed | Labels: accuracy | Documents | Photos | Fields: precision | Fields: recall | Detail recall | Detail missed | Descriptions | Cost / image | Cost / case (300) | Cost / month (90k) | p50 / p95 latency | Result |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summaries) {
    out.push(`| ${s.model} | ${s.files} | ${s.failed} | ${pc(s.accuracy)} | ${pc(s.documentAccuracy)} | ${pc(s.photoAccuracy)} | ${pc(s.fields?.precision ?? null)} | ${pc(s.fields?.recall ?? null)} | ${pc(s.detail.recall)} | ${s.detail.missed} | ${pc(s.descriptionRate)} | ${usd(s.cost.perImage, 6)} | ${usd(s.cost.perCase300, 3)} | ${usd(s.cost.perMonth90k)} | ${s.latency.p50 ?? '—'} / ${s.latency.p95 ?? '—'} ms | ${yes(s.pass.overall)} |`);
  }
  out.push('', 'Field matching is reported, not yet a pass mark: set its threshold after the first run (D35).');
  for (const s of summaries) {
    out.push('', `## ${s.model}`, '');
    out.push('Confidence routing (labels below the threshold go to the larger model or to a person):', '');
    out.push('| Threshold | Handled by this model | Accuracy on those |', '|---|---|---|');
    for (const r of s.routing) out.push(`| ${r.threshold} | ${pc(r.coverage)} | ${pc(r.accuracy)} |`);
    out.push('', '| Category | Files | Recall | Precision |', '|---|---|---|---|');
    for (const c of s.categories) out.push(`| ${c.code} | ${c.support} | ${pc(c.recall)} | ${pc(c.precision)} |`);
    if (s.confusions.length) {
      out.push('', 'Most frequent mistakes:', '', '| Correct | Model said | Times |', '|---|---|---|');
      for (const c of s.confusions) out.push(`| ${c.truth} | ${c.predicted} | ${c.count} |`);
    }
  }
  return out.join('\n') + '\n';
}
