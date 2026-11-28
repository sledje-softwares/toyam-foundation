// `field_suggest` stage (6.5): pattern rules on the file's current OCR text (PDF text layer, device or server
// OCR) for the fields the label stage matched, plus the fields of sections that list the file's categories.
import type { PipelineDb } from '../db.ts';
import type { TemplateCache } from '../template-context.ts';
import type { Logger } from '../log.ts';
import { suggestForField } from '../rules.ts';
import type { Job, OcrBlock, StageOutcome, SuggestionRow } from '../types.ts';

function linesAsBlocks(text: string): OcrBlock[] {
  return text.split('\n').filter((l) => l.trim() !== '').map((l, i) => ({ text: l.trim(), bbox: [0, 0, 0, 0], conf: 1, line: i + 1 }));
}

export function createFieldSuggestStage(deps: { db: PipelineDb; templates: TemplateCache; log: Logger; minMatchScore: number }) {
  return async function fieldSuggest(job: Job): Promise<StageOutcome> {
    const ev = await deps.db.getEvidence(job.evidence_id);
    if (!ev) return { status: 'skipped', reason: 'evidence_not_found' };
    if (ev.withdrawn_at) return { status: 'skipped', reason: 'withdrawn' };
    if (!ev.template_id) return { status: 'skipped', reason: 'case_has_no_template' };
    // independent reads, one round trip (the template is cached, so it costs nothing when warm)
    const [wanted, currentOcr, ctx, matches, labels] = await Promise.all([
      deps.db.ocrWanted(ev.id), deps.db.getCurrentOcr(ev.id), deps.templates.get(ev.template_id),
      deps.db.getFieldMatches(ev.id), deps.db.getActiveLabels(ev.id),
    ]);
    if (!wanted) return { status: 'skipped', reason: 'ocr_not_wanted' };
    // any current OCR: PDF text layer, device OCR (mlkit_device) or server OCR
    const ocr = currentOcr.filter((r) => r.text.trim() !== '' || r.blocks.length > 0);
    if (ocr.length === 0) return { status: 'skipped', reason: 'no_ocr_text' };

    const keys = new Set<string>();
    for (const m of matches) if (m.score >= deps.minMatchScore) {
      const f = ctx.fieldById.get(m.field_id);
      if (f) keys.add(f.key);
    }
    for (const l of labels) for (const k of ctx.fieldsByCategory.get(l.category_id) ?? []) keys.add(k);

    const rows: SuggestionRow[] = [];
    for (const f of ctx.fields) {
      if (!keys.has(f.key)) continue;
      for (const page of ocr) {
        // rows with text but no blocks: rules run on the text lines, and the suggestion points at no block
        const hasBlocks = page.blocks.length > 0;
        const blocks = hasBlocks ? page.blocks : linesAsBlocks(page.text);
        for (const c of suggestForField(f, blocks)) {
          rows.push({ ocr_id: page.id, field_key: f.key, value: c.value, confidence: c.confidence, block_index: hasBlocks ? c.block_index : null });
        }
      }
    }
    // always written, even when empty: clears pending suggestions of an earlier run
    const n = await deps.db.recordFieldSuggestions(ev.id, rows);
    deps.log.log('info', 'suggestions_recorded', { job_id: job.id, evidence_id: ev.id, fields: keys.size, suggestions: n });
    return { status: 'done' };
  };
}
