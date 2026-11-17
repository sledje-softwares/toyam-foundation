// The two insurer layouts (config/templates/layouts/*.yaml): load with their templates, validate, and render both
// writers with invented data that fills every field. Set REPORT_OUT_DIR to keep the rendered .html / .docx files
// (then `soffice --headless --convert-to pdf` them to compare with the insurer's sample by eye).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bindReport, type ReportData, type ReportPhoto } from '../../../supabase/functions/_shared/report/bind.ts';
import { renderReportDocx } from '../../../supabase/functions/_shared/report/docx.ts';
import { renderReportHtml } from '../../../supabase/functions/_shared/report/html.ts';
import type { ReportLayout } from '../../../supabase/functions/_shared/report/spec.ts';
import { TEMPLATES_DIR, readYaml, resolveTemplateLayout, type TemplateYaml } from '../src/template-config.ts';
import { photoA, photoB, readZip } from './report-helpers.ts';

const NOW = new Date('2099-01-10T06:45:00Z');
const OUT = process.env.REPORT_OUT_DIR;

interface FieldDef { key: string; label: string; type?: string; options?: string[] }
interface SectionDef { key: string; fields?: FieldDef[] }

const LONG = 'Invented narrative sentence one for the layout test. A second sentence follows so that the justified text wraps across a few lines in the cell and the writers show the paragraph spacing.';
const OVERRIDES: Record<string, string> = {
  investigation_points: Array.from({ length: 6 }, (_, i) => `${i + 1}. Invented point number ${i + 1} to address in the field.`).join('\n'),
  statements: [
    'Mr. Example One (Rider statement)\n' + LONG + '\n\n' + LONG,
    'Ms. Example Two (Insured statement)\n' + LONG,
  ].join('\n---\n'),
  findings: Array.from({ length: 4 }, (_, i) => `${i + 1}. ${LONG}\n\nContinuation paragraph of finding ${i + 1}.`).join('\n'),
  documents_collected: 'RC copy\nPolicy copy\nEstimate of the vehicle\nPhotographs of the vehicle',
  observations: Array.from({ length: 5 }, (_, i) => `Invented observation ${i + 1}: ${LONG}`).join('\n'),
  written_statement: LONG + '\n\n' + LONG,
  case_summary: LONG + '\n\n' + LONG,
  final_conclusion: LONG + '\n\n' + LONG + '\n\n**Invented bold closing sentence.**',
  conclusion: LONG + '\n\n' + LONG + '\n\n**Invented bold closing sentence.**',
  investigation_status: 'Invented status text.',
  submission_date: '2099-01-09',
  loss_datetime: '2099-01-01T11:00',
  intimation_datetime: '2099-01-03T23:04',
};

function value(f: FieldDef): string {
  if (OVERRIDES[f.key] !== undefined && !(f.type === 'choice')) return OVERRIDES[f.key];
  switch (f.type) {
    case 'date': return '2099-01-02';
    case 'datetime': return '2099-01-02T10:30';
    case 'number': return '3';
    case 'choice': return f.options?.[0] ?? 'Yes';
    case 'long_text': return LONG;
    default: return `Invented ${f.label.toLowerCase()}`;
  }
}

function load(file: string): { template: TemplateYaml; layout: ReportLayout } {
  const path = `${TEMPLATES_DIR}${file}`;
  const { config, errors } = resolveTemplateLayout(readYaml<TemplateYaml>(path), path);
  assert.deepEqual(errors, []);
  return { template: config, layout: config.report_layout as ReportLayout };
}

function dataFor(template: TemplateYaml, opts: { withAssets: boolean }): ReportData {
  const sections = template.sections as unknown as SectionDef[];
  const fields: ReportData['fields'] = {};
  for (const s of sections) for (const f of s.fields ?? []) fields[f.key] = { type: f.type ?? 'text', label: f.label, value: value(f) };
  const photos: Record<string, ReportPhoto[]> = {};
  for (const s of sections) {
    photos[s.key] = Array.from({ length: s.key === 'garage' ? 5 : 2 }, (_, i) => ({
      evidence_id: `${s.key}-${i}`, caption: `Invented photo ${i + 1}`,
      image: { bytes: i % 2 ? photoB() : photoA(), mime: 'image/jpeg' as const },
    }));
  }
  const img = { bytes: photoB(), mime: 'image/jpeg' as const };
  return {
    case: {
      case_ref: 'INV-2099-000001', insurer_code: 'EXM', insurer_name: 'Example Insurance Ltd', claim_no: 'EX/CLM/0001',
      policy_no: 'EX-POL-0001', template_key: 'x', template_name: 'x', template_version: 1, office_owner_name: 'Asha Example',
      received_at: '2099-01-02T04:30:00Z', due_at: '2099-01-17T04:30:00Z', generated_at: '2099-01-10T06:45:00+00:00', report_version: 1,
    },
    fields,
    photos,
    assets: opts.withAssets ? { band_top: img, logo: img, band_bottom: img, seal: img } : {},
  };
}

for (const [file, name] of [['icl-motor-od.yaml', 'ICICI Lombard Motor OD'], ['igi-motor-od.yaml', 'IndusInd / Reliance Motor OD']] as const) {
  describe(`layout: ${name}`, () => {
    const { template, layout } = load(file);
    const slug = file.replace('.yaml', '');

    it('is wired to the template and validates against its fields', () => {
      assert.match(String(readYaml<TemplateYaml>(`${TEMPLATES_DIR}${file}`).report_layout), /^layouts\/.+\.yaml$/);
      assert.equal(layout.version, 1);
    });

    it('prints every template field and every photo section it is meant to', () => {
      const data = dataFor(template, { withAssets: true });
      const { html, warnings } = renderReportHtml(layout, data, { now: NOW });
      assert.deepEqual(warnings, []);
      const text = html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
      const skip = new Set(file.startsWith('icl') ? ['insurer_internal_claim_no', 'investigation_points'] : []); // intake-only facts the sample does not print
      const missing: string[] = [];
      for (const s of template.sections as unknown as SectionDef[]) {
        for (const f of s.fields ?? []) {
          if (skip.has(f.key)) continue;
          // dates and datetimes are reformatted, so look for a distinctive part of the invented value only
          const v = value(f);
          if (f.type === 'date' || f.type === 'datetime') continue;
          const probe = v.split('\n')[0].replace(/^\d+\.\s*/, '').replace(/\*\*/g, '').slice(0, 25);
          if (!text.includes(probe)) missing.push(f.key);
        }
      }
      assert.deepEqual(missing, [], `fields not printed: ${missing.join(', ')}`);
      assert.ok((html.match(/data:image\/jpeg/g) ?? []).length >= 8, 'photos embedded');
    });

    it('renders **bold** markup in the conclusion narrative (and never prints the asterisks)', () => {
      const { html } = renderReportHtml(layout, dataFor(template, { withAssets: true }), { now: NOW });
      assert.match(html, /font-weight:bold[^>]*>Invented bold closing sentence\.</);
      assert.ok(!html.includes('**'), 'no literal ** left in the output');
    });

    it('renders both writers with and without the runtime assets', async () => {
      for (const withAssets of [true, false]) {
        const data = dataFor(template, { withAssets });
        const out = renderReportHtml(layout, data, { now: NOW });
        if (!withAssets) assert.ok(out.warnings.length > 0, 'missing runtime assets are reported');
        const docx = await renderReportDocx(layout, data, { now: NOW, creator: 'Report tests' });
        const parts = readZip(docx);
        assert.ok(parts.has('word/document.xml'));
        assert.ok(bindReport(layout, data, { now: NOW }));
        if (OUT && withAssets) {
          mkdirSync(OUT, { recursive: true });
          writeFileSync(join(OUT, `${slug}.html`), out.html);
          writeFileSync(join(OUT, `${slug}.docx`), docx);
        }
      }
    });

    it('survives a case with no optional values and no photos', async () => {
      const data = dataFor(template, { withAssets: true });
      data.photos = {};
      for (const k of Object.keys(data.fields)) data.fields[k].value = null;
      const { html } = renderReportHtml(layout, data, { now: NOW });
      assert.ok(html.length > 1000);
      await renderReportDocx(layout, data, { now: NOW });
    });
  });
}
