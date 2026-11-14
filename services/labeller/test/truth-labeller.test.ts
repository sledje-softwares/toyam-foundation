import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parseTruthCsv } from '../src/truth.ts';
import type { TruthRow } from '../src/score.ts';

const html = readFileSync(new URL('../tools/truth-labeller.html', import.meta.url), 'utf8');
const core = /<script id="truth-core">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
const buildTruthCsv = new Function(`${core}; return buildTruthCsv;`)() as (rows: TruthRow[]) => string;
const categories = parseYaml(readFileSync(new URL('../../../config/templates/_categories.yaml', import.meta.url), 'utf8')) as Array<{ code: string }>;
const allowed = new Set(categories.map((c) => c.code));

describe('truth-labeller.html', () => {
  test('exported CSV is read back identically by the real parser', () => {
    const rows: TruthRow[] = [
      { file: 'case01/IMG_0001.jpg', codes: ['vehicle_photo'], needs_detail: false, fields: [] },
      { file: 'case01/IMG 0002.jpg', codes: ['odometer_photo', 'chassis_engine_photo'], needs_detail: true, fields: ['vehicle_no', 'insured_name', 'policy_no'] },
      { file: 'case 02/a, b "x".jpg', codes: ['spot_photo', 'insured_photo', 'rc_document'], needs_detail: true, fields: [] },
      { file: 'case02/unmarked.jpg', codes: ['rc_document'], needs_detail: null, fields: null },
    ];
    const csv = buildTruthCsv(rows);
    assert.ok(csv.startsWith('file,categories,needs_detail,fields\r\n'));
    const { rows: back, errors } = parseTruthCsv(csv, allowed, new Set(['vehicle_no', 'insured_name', 'policy_no']));
    assert.deepEqual(errors, []);
    assert.deepEqual(back, rows);
  });

  test('embedded categories match _categories.yaml (rebuild with npm run build:truth-labeller)', () => {
    const json = /\/\*EMBED:DATA\*\/([\s\S]*?)\/\*END:DATA\*\//.exec(html)?.[1] ?? '';
    const data = JSON.parse(json) as { categories: Array<{ code: string }>; templates: Array<{ id: string; sections: unknown[] }> };
    assert.deepEqual(data.categories.map((c) => c.code), categories.map((c) => c.code));
    assert.ok(data.templates.length >= 2);
    assert.ok(data.templates.every((t) => t.sections.length > 0));
  });
});
