import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ruleKind, suggestForField, dates, amounts } from '../src/rules.ts';
import { createFieldSuggestStage } from '../src/stages/field-suggest.ts';
import { TemplateCache } from '../src/template-context.ts';
import { memoryLogger } from '../src/log.ts';
import type { OcrBlock } from '../src/types.ts';
import { FakeDb, evidence, job } from './fakes.ts';

const blocks = (...lines: string[]): OcrBlock[] => lines.map((text, i) => ({ text, bbox: [0, i * 20, 100, 18], conf: 0.95, line: i + 1 }));
const f = (key: string, label = key, field_type = 'text') => ({ key, label, field_type });

describe('field rules', () => {
  test('rule kind from key and type', () => {
    assert.equal(ruleKind(f('reg_number')), 'registration');
    assert.equal(ruleKind(f('vehicle_no')), 'registration');
    assert.equal(ruleKind(f('chassis_no')), 'chassis');
    assert.equal(ruleKind(f('engine_no')), 'engine');
    assert.equal(ruleKind(f('dl_number')), 'dl');
    assert.equal(ruleKind(f('policy_no')), 'policy');
    assert.equal(ruleKind(f('rollover_policy_no')), 'policy');
    assert.equal(ruleKind(f('insurer_claim_no')), 'claim');
    assert.equal(ruleKind(f('reg_date', 'Registration date', 'date')), 'date');
    assert.equal(ruleKind(f('odometer_at_entry')), 'odometer');
    assert.equal(ruleKind(f('garage_name')), null);
    assert.equal(ruleKind(f('vehicle_class')), null);
  });

  test('registration numbers, normalised; state codes raise confidence', () => {
    const c = suggestForField(f('reg_number'), blocks('Regn. No.: MH 12 AB 1234', 'XX 99 Z 0001', '22 BH 1234 AA'));
    assert.deepEqual(c.map((x) => x.value), ['MH12AB1234', '22BH1234AA', 'XX99Z0001']);
    assert.equal(c[0].block_index, 0);
  });

  test('17-character VIN without I, O or Q', () => {
    const c = suggestForField(f('chassis_no'), blocks('Chassis No MA3EWDE1S00123456', 'ABCDEFGHIJKLMNOPQ', '12345678901234567'));
    assert.deepEqual(c.map((x) => x.value), ['MA3EWDE1S00123456']);
  });

  test('DL numbers in the 15-character format', () => {
    const c = suggestForField(f('dl_number'), blocks('DL No. MH12 20110012345', 'Issued 01/02/2011'));
    assert.deepEqual(c.map((x) => x.value), ['MH1220110012345']);
  });

  test('labelled numbers: policy and engine', () => {
    assert.deepEqual(suggestForField(f('policy_no'), blocks('Policy No: 3001/123456789/00/000')).map((x) => x.value), ['3001/123456789/00/000']);
    assert.deepEqual(suggestForField(f('engine_no'), blocks('Engine No. JF50ET1234567')).map((x) => x.value), ['JF50ET1234567']);
  });

  test('dates in Indian formats become ISO; invalid dates dropped', () => {
    assert.deepEqual(dates('12.03.2024 05/11/2019 7-Jan-2020 31/02/2024 2025-12-01').map(([v]) => v).sort(),
      ['2019-11-05', '2020-01-07', '2024-03-12', '2025-12-01']);
  });

  test('several dates: the one next to the field hint ranks first', () => {
    const c = suggestForField(f('driver_dob', 'Driver DOB as per DL', 'date'), blocks('Issue date 01-02-2011', 'DOB: 15-08-1990', 'Valid till 14-08-2030'));
    assert.equal(c[0].value, '1990-08-15');
    assert.ok(c[0].confidence > (c[1]?.confidence ?? 0));
  });

  test('amounts with currency markers', () => {
    assert.deepEqual(amounts('Total Rs. 1,23,456.50 and ₹ 900').map(([v]) => v), ['123456.50', '900']);
  });
});

describe('field_suggest stage', () => {
  function setup() {
    const db = new FakeDb();
    db.evidence.set('e1', evidence({ evidence_type: 'document', mime_type: 'application/pdf' }));
    db.ocr.push({ id: 'o1', evidence_id: 'e1', page_no: 1, engine: 'pdf_text_layer', is_current: true, mean_confidence: 1,
      text: '', blocks: blocks('Regn. No.: MH 12 AB 1234', 'DL No. MH12 20110012345', 'Chassis MA3EWDE1S00123456') });
    db.ocr[0].text = db.ocr[0].blocks.map((b) => b.text).join('\n');
    return { db, run: createFieldSuggestStage({ db, templates: new TemplateCache(db), log: memoryLogger(), minMatchScore: 0.3 }) };
  }

  test('suggests values for matched fields and for fields of sections listing the file category', async () => {
    const s = setup();
    s.db.matches.push({ evidence_id: 'e1', field_id: 'f-reg', score: 0.8 }, { evidence_id: 'e1', field_id: 'f-chassis', score: 0.1 });
    s.db.labels.push({ evidence_id: 'e1', category_id: 'c-dl', source: 'filename_rule', needs_detail: null, is_active: true, model: null, version: null });
    assert.deepEqual(await s.run(job({ stage: 'field_suggest' })), { status: 'done' });
    const rows = s.db.suggestions[0].rows;
    assert.deepEqual(rows.map((r) => `${r.field_key}=${r.value}`).sort(), ['dl_number=MH1220110012345', 'reg_number=MH12AB1234']);
    assert.ok(rows.every((r) => r.ocr_id === 'o1'));
    assert.equal(rows.find((r) => r.field_key === 'dl_number')!.block_index, 1);
  });

  test('runs on device OCR rows (mlkit_device), also when they carry text without blocks', async () => {
    const s = setup();
    s.db.ocr = [{ id: 'd1', evidence_id: 'e1', page_no: 1, engine: 'mlkit_device', is_current: true, mean_confidence: 0.8,
      text: 'Regn. No.: MH 12 AB 1234\nsomething else', blocks: [] }];
    s.db.matches.push({ evidence_id: 'e1', field_id: 'f-reg', score: 0.9 });
    assert.deepEqual(await s.run(job({ stage: 'field_suggest' })), { status: 'done' });
    assert.deepEqual(s.db.suggestions[0].rows, [{ ocr_id: 'd1', field_key: 'reg_number', value: 'MH12AB1234', confidence: 0.8, block_index: null }]);
  });

  test('skipped without OCR text or when OCR is not wanted; still writes (clears) when nothing matches', async () => {
    let s = setup();
    s.db.wanted.set('e1', false);
    assert.deepEqual(await s.run(job({ stage: 'field_suggest' })), { status: 'skipped', reason: 'ocr_not_wanted' });
    s = setup();
    s.db.ocr = [];
    assert.deepEqual(await s.run(job({ stage: 'field_suggest' })), { status: 'skipped', reason: 'no_ocr_text' });
    s = setup();
    assert.deepEqual(await s.run(job({ stage: 'field_suggest' })), { status: 'done' });
    assert.deepEqual(s.db.suggestions, [{ evidenceId: 'e1', rows: [] }]);
  });
});
