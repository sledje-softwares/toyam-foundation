// Category → field maps (config/templates/maps/*.yaml, docs/09 "Category → field map", docs/14 gap 26).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TEMPLATES_DIR, type TemplateYaml, checkCategoryMap, readCategoryMap, readYaml, resolveCategoryMap, resolveTemplate,
  templateFiles,
} from '../src/template-config.ts';

const codes = readYaml<Array<{ code: string }>>(`${TEMPLATES_DIR}_categories.yaml`).map((c) => c.code);

const tpl: TemplateYaml = {
  insurer_code: 'X', claim_type: 'motor', name: 'x',
  sections: [{ key: 's', title: 'S', fields: [{ key: 'insurer_claim_no', label: 'Claim' }, { key: 'dl_number', label: 'DL no.' }] }],
};

describe('category map check', () => {
  it('accepts a valid map and reports what is not reviewed', () => {
    const r = checkCategoryMap({ categories: { dl_document: { dl_number: 0.95 }, other: {} } }, tpl, ['dl_document', 'other', 'rc_document']);
    assert.deepEqual(r.errors, []);
    assert.equal(r.pairs, 1);
    assert.deepEqual(r.missingCategories, ['rc_document']);
    assert.deepEqual(r.emptyCategories, ['other']);
    assert.deepEqual(r.unreviewedFields, ['insurer_claim_no']);
  });

  it('accepts fields listed in unmapped_fields', () => {
    const r = checkCategoryMap({ categories: { dl_document: { dl_number: 0.9 } }, unmapped_fields: ['insurer_claim_no'] }, tpl, ['dl_document']);
    assert.deepEqual(r.unreviewedFields, []);
    assert.deepEqual(r.acceptedUnmappedFields, ['insurer_claim_no']);
  });

  it('rejects unknown categories, unknown fields and bad scores', () => {
    const r = checkCategoryMap({
      categories: { nope: { dl_number: 0.5 }, dl_document: { dl_nmber: 0.5, dl_number: 1.5 } },
      unmapped_fields: ['dl_number', 'ghost'],
    }, tpl, ['dl_document']);
    assert.deepEqual(r.errors, [
      'unknown category nope',
      'dl_document: unknown field dl_nmber',
      'dl_document.dl_number: score must be a number in (0, 1]',
      'unmapped_fields: dl_number is mapped by a category',
      'unmapped_fields: unknown field ghost',
    ]);
  });
});

describe('config/templates maps', () => {
  for (const file of templateFiles()) {
    const t = readYaml<TemplateYaml>(file);
    it(`${file.split('/').pop()} has a complete, valid map`, () => {
      const map = readCategoryMap(t, file);
      assert.ok(map, 'template names a category_map');
      const r = checkCategoryMap(map, t, codes);
      assert.deepEqual(r.errors, []);
      assert.deepEqual(r.missingCategories, [], 'every category is listed (use {} for none)');
      assert.deepEqual(r.unreviewedFields, [], 'every field is mapped or listed in unmapped_fields');
      assert.equal(map.reviewed, false, 'generated map waits for the office review');
    });

    it(`${file.split('/').pop()} resolves to category_fields with scores only`, () => {
      const { config, errors } = resolveTemplate(t, file, codes);
      assert.deepEqual(errors, []);
      assert.equal(config.category_map, undefined, 'the file reference is replaced');
      const cf = config.category_fields as Record<string, Record<string, number>>;
      assert.ok(Object.keys(cf).length > 10);
      assert.equal(cf.other, undefined, 'empty entries are not sent');
      for (const fields of Object.values(cf)) for (const s of Object.values(fields)) assert.ok(s > 0 && s <= 1);
      if (file.endsWith('theft.yaml')) assert.ok(cf.loan_document.loan_statement >= 0.9, 'a loan document is evidence for the loan statement');
      else assert.ok(cf.dl_document.dl_number >= 0.9, 'a DL is evidence for the DL number');
    });
  }

  it('the ICICI map has no chassis/engine fields to map yet (gap 23)', () => {
    const file = templateFiles().find((f) => f.endsWith('icl-motor-od.yaml'))!;
    const { config } = resolveCategoryMap(readYaml<TemplateYaml>(file), file, codes);
    const cf = config.category_fields as Record<string, Record<string, number>>;
    assert.deepEqual(Object.keys(cf.chassis_engine_photo), ['make_model']);
  });

  it('a bad map path is an error, not a crash', () => {
    const { errors } = resolveCategoryMap({ ...tpl, category_map: '../outside.yaml' }, `${TEMPLATES_DIR}x.yaml`, codes);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^category_map: /);
  });
});
