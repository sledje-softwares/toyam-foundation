import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { buildSystemPrompt, parseLabelAnswer, templateFieldKeys, sectionsFor, MAX_LABELS, MAX_FIELDS } from '../src/prompt.ts';
import type { LabelCategory, LabelTemplate } from '../src/prompt.ts';
import { buildRequest, readResponse, parseModelRef, callModel, modelKey } from '../src/providers.ts';
import type { ImageInput } from '../src/providers.ts';
import { costOf, findPrice, DEFAULT_PRICES } from '../src/prices.ts';
import { parseTruthCsv, splitCsvLine } from '../src/truth.ts';
import { summarise, renderMarkdown, DEFAULT_PASS_MARKS } from '../src/score.ts';
import type { RunRecord, TruthRow } from '../src/score.ts';

const categories = parseYaml(readFileSync(new URL('../../../config/templates/_categories.yaml', import.meta.url), 'utf8')) as LabelCategory[];
const codes = new Set(categories.map((c) => c.code));
const template = parseYaml(readFileSync(new URL('../../../config/templates/igi-motor-od.yaml', import.meta.url), 'utf8')) as LabelTemplate;
const fieldKeys = templateFieldKeys(template);
const image: ImageInput = { base64: 'AAAA', mimeType: 'image/jpeg', longEdge: 384 };

describe('prompt', () => {
  test('lists every category with its description, and the answer format', () => {
    const p = buildSystemPrompt(categories);
    for (const c of categories) assert.ok(p.includes(`- ${c.code}: ${c.name}`), c.code);
    assert.ok(p.includes('Stamped chassis (VIN)'));
    assert.ok(p.includes('"needs_detail"'));
    assert.ok(p.includes('do not judge whether the claim is genuine'));
  });

  test('with a template: lists fields grouped by section and asks for field matches', () => {
    const p = buildSystemPrompt(categories, template);
    assert.ok(p.includes('Driver details:\n- driver_name: Driver name'));
    assert.ok(p.includes('- dl_number: DL number of the driver (Copy from the DL extract (tap-to-fill))'));
    assert.ok(p.includes('"fields":[{"key":"<field key>"'));
    assert.ok(p.includes('Do not read or return the values'));
    assert.ok(!buildSystemPrompt(categories).includes('"fields"'), 'no fields without a template');
  });

  test('description only where useful; "null" and empty mean none', () => {
    const p = buildSystemPrompt(categories, template);
    assert.ok(p.includes('Otherwise null (for example a clear RC, DL, policy copy or bill)'));
    for (const d of ['null', '""', '"  "', '"null"']) {
      assert.equal(parseLabelAnswer(`{"labels":[{"code":"rc_document","confidence":0.9}],"needs_detail":true,"description":${d}}`, codes).description, null, d);
    }
  });

  test('field matches: validated against the template, best first, at most MAX_FIELDS', () => {
    const fields = ['dl_number', 'dl_validity', 'dl_classes', 'dl_authority', 'dl_type', 'driver_dob', 'made_up', 'dl_number']
      .map((key, i) => ({ key, confidence: 0.95 - i / 20 }));
    const a = parseLabelAnswer(JSON.stringify({ labels: [{ code: 'dl_document', confidence: 0.97 }], fields, needs_detail: true }), codes, fieldKeys);
    assert.equal(a.fields.length, MAX_FIELDS);
    assert.deepEqual(a.fields.map((f) => f.key), ['dl_number', 'dl_validity', 'dl_classes', 'dl_authority', 'dl_type']);
    assert.match(a.error!, /unknown field "made_up"/);
    assert.equal(a.ok, true, 'a bad field does not discard the labels');
  });

  test('sections follow from labels (section categories) and matched fields', () => {
    assert.deepEqual(sectionsFor(template, ['dl_document'], []), ['driver']);
    assert.deepEqual(sectionsFor(template, ['spot_photo'], ['fir_no_date']), ['fir', 'spot']);
    assert.deepEqual(sectionsFor(template, ['other'], []), []);
  });

  test('every category has a description for the labeller', () => {
    assert.deepEqual(categories.filter((c) => !c.description).map((c) => c.code), []);
  });

  test('parses a clean answer, best label first', () => {
    const a = parseLabelAnswer('{"labels":[{"code":"chassis_engine_photo","confidence":0.6},{"code":"odometer_photo","confidence":0.9}],"needs_detail":true,"detail_reason":"odometer reading","description":"Cluster and VIN plate"}', codes);
    assert.equal(a.ok, true);
    assert.deepEqual(a.labels.map((l) => l.code), ['odometer_photo', 'chassis_engine_photo']);
    assert.equal(a.needs_detail, true);
    assert.equal(a.detail_reason, 'odometer reading');
    assert.equal(a.error, undefined);
  });

  test('accepts code fences and surrounding text; braces inside strings do not confuse it', () => {
    const a = parseLabelAnswer('Here you go:\n```json\n{"labels":[{"code":"estimate","confidence":0.8}],"needs_detail":true,"detail_reason":null,"description":"Estimate {page 1}"}\n```', codes);
    assert.equal(a.ok, true);
    assert.equal(a.description, 'Estimate {page 1}');
  });

  test('drops unknown and duplicate codes, clamps confidence, keeps at most MAX_LABELS', () => {
    const labels = ['vehicle_photo', 'spot_photo', 'insured_photo', 'other', 'vehicle_photo', 'made_up']
      .map((code, i) => ({ code, confidence: i === 0 ? 7 : 0.5 - i / 10 }));
    const a = parseLabelAnswer(JSON.stringify({ labels, needs_detail: false, description: 'x' }), codes);
    assert.equal(a.labels.length, MAX_LABELS);
    assert.equal(a.labels[0].confidence, 1);
    assert.match(a.error!, /unknown category "made_up"/);
    assert.equal(a.ok, true);
  });

  test('a missing needs_detail flag counts as "needs detail"; reason is dropped when not needed', () => {
    assert.equal(parseLabelAnswer('{"labels":[{"code":"other","confidence":0.4}]}', codes).needs_detail, true);
    assert.equal(parseLabelAnswer('{"labels":[{"code":"spot_photo","confidence":0.9}],"needs_detail":false,"detail_reason":"x"}', codes).detail_reason, null);
  });

  test('unusable answers never throw', () => {
    for (const t of ['', 'no json here', '{"labels":', '[1,2]', '{"labels":[{"code":"nope","confidence":1}]}']) {
      const a = parseLabelAnswer(t, codes);
      assert.equal(a.ok, false, t);
      assert.ok(a.error, t);
    }
  });
});

describe('providers', () => {
  test('model references', () => {
    assert.deepEqual(parseModelRef('anthropic:claude-haiku-5-5'), { provider: 'anthropic', model: 'claude-haiku-5-5' });
    assert.equal(parseModelRef('openrouter:qwen/qwen3-vl-8b-instruct').baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(parseModelRef('local:Qwen/Qwen3-VL-8B-Instruct', 'http://gpu:8000/v1/').baseUrl, 'http://gpu:8000/v1');
    assert.equal(modelKey(parseModelRef('google:gemini-2.5-flash-lite')), 'google/gemini-2.5-flash-lite');
    assert.throws(() => parseModelRef('claude-haiku'), /provider:model-id/);
    assert.throws(() => parseModelRef('mistral:pixtral'), /provider/);
    assert.throws(() => parseModelRef('local:qwen'), /LOCAL_VLM_BASE_URL/);
  });

  test('Anthropic request caches the system prompt and sends the image first', () => {
    const r = buildRequest(parseModelRef('anthropic:claude-haiku-5-5'), 'k', 'SYS', 'Label this image.', image);
    const body = r.body as any;
    assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(r.headers['x-api-key'], 'k');
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
    assert.equal(body.messages[0].content[0].type, 'image');
    assert.equal(body.messages[0].content[0].source.data, 'AAAA');
  });

  test('Gemini request asks for JSON', () => {
    const r = buildRequest(parseModelRef('google:gemini-2.5-flash-lite'), 'k', 'SYS', 'go', image);
    assert.match(r.url, /models\/gemini-2\.5-flash-lite:generateContent$/);
    assert.equal((r.body as any).generationConfig.responseMimeType, 'application/json');
    assert.equal((r.body as any).contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
  });

  test('OpenAI-compatible requests: OpenAI, DeepSeek, OpenRouter, local', () => {
    const urls = ['openai:gpt-5.4-nano', 'deepseek:deepseek-flash', 'openrouter:qwen/qwen3-vl-8b-instruct']
      .map((s) => buildRequest(parseModelRef(s), 'k', 'SYS', 'go', image).url);
    assert.deepEqual(urls, ['https://api.openai.com/v1/chat/completions', 'https://api.deepseek.com/chat/completions',
                            'https://openrouter.ai/api/v1/chat/completions']);
    const local = buildRequest(parseModelRef('local:qwen3-vl', 'http://gpu:8000/v1'), '', 'SYS', 'go', image);
    assert.equal(local.url, 'http://gpu:8000/v1/chat/completions');
    assert.equal(local.headers.authorization, undefined);
    const body = local.body as any;
    assert.equal(body.messages[1].content[0].image_url.detail, 'low');
    const high = buildRequest(parseModelRef('openai:x'), 'k', 'S', 'go', { ...image, longEdge: 1568 }).body as any;
    assert.equal(high.messages[1].content[0].image_url.detail, 'high');
  });

  test('reads text and usage from each provider', () => {
    assert.deepEqual(readResponse('anthropic', { content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 300, output_tokens: 70, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } }),
      { text: '{"a":1}', usage: { input: 300, cachedRead: 900, cacheWrite: 0, output: 70 } });
    assert.deepEqual(readResponse('google', { candidates: [{ content: { parts: [{ text: 'think', thought: true }, { text: '{}' }] } }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 50, thoughtsTokenCount: 20 } }),
      { text: '{}', usage: { input: 400, cachedRead: 600, cacheWrite: 0, output: 70 } });
    assert.deepEqual(readResponse('openai', { choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 500, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 300 } } }),
      { text: '{}', usage: { input: 200, cachedRead: 300, cacheWrite: 0, output: 80 } });
    assert.deepEqual(readResponse('deepseek', { choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 500, completion_tokens: 80, prompt_cache_hit_tokens: 450 } }).usage,
      { input: 50, cachedRead: 450, cacheWrite: 0, output: 80 });
  });

  test('callModel retries rate limits and server errors, not bad requests', async () => {
    const statuses = [429, 503, 200];
    let calls = 0;
    const fakeFetch = async () => {
      const status = statuses[calls++];
      return { ok: status === 200, status, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }), text: async () => 'busy' };
    };
    const reply = await callModel(fakeFetch, parseModelRef('openai:x'), 'k', 'S', 'go', image, { sleep: async () => {} });
    assert.equal(reply.text, 'ok');
    assert.equal(calls, 3);

    let badCalls = 0;
    const bad = async () => { badCalls++; return { ok: false, status: 400, json: async () => ({}), text: async () => 'This model does not support image' }; };
    await assert.rejects(callModel(bad, parseModelRef('deepseek:deepseek-chat'), 'k', 'S', 'go', image, { sleep: async () => {} }), /HTTP 400 This model does not support image/);
    assert.equal(badCalls, 1);
  });
});

describe('prices', () => {
  test('cost of a call; prefix match for dated ids; null when unknown', () => {
    const usage = { input: 600, cachedRead: 0, cacheWrite: 0, output: 80 };
    assert.ok(Math.abs(costOf('anthropic/claude-haiku-5-5', usage)! - (600 * 0.10 + 80 * 0.50) / 1e6) < 1e-12);
    assert.equal(findPrice('google/gemini-2.5-flash-lite-preview-09', DEFAULT_PRICES), DEFAULT_PRICES['google/gemini-2.5-flash-lite']);
    assert.equal(costOf('local/qwen3-vl', usage), null);
  });
});

describe('ground truth', () => {
  test('parses rows, multi-labels and the detail flag', () => {
    const { rows, errors } = parseTruthCsv('﻿file,categories,needs_detail\ncase01/a.jpg,vehicle_photo,no\n"case01/b, odo.jpg",odometer_photo;chassis_engine_photo,yes\n# comment\ncase01/c.jpg,rc_document,\n', codes);
    assert.deepEqual(errors, []);
    assert.deepEqual(rows, [
      { file: 'case01/a.jpg', codes: ['vehicle_photo'], needs_detail: false, fields: null },
      { file: 'case01/b, odo.jpg', codes: ['odometer_photo', 'chassis_engine_photo'], needs_detail: true, fields: null },
      { file: 'case01/c.jpg', codes: ['rc_document'], needs_detail: null, fields: null },
    ]);
  });

  test('reports mistakes with line numbers', () => {
    const { errors } = parseTruthCsv('file,categories,needs_detail\na.jpg,vehicle_photo,no\na.jpg,vehicle_photo,no\nb.jpg,,no\nc.jpg,car,no\nd.jpg,other,maybe\n', codes);
    assert.deepEqual(errors, ['line 3: a.jpg listed twice', 'line 4: no category for b.jpg', 'line 5: unknown category car', 'line 6: needs_detail must be yes or no']);
  });

  test('optional fields column: keys, "-" for none, blank for not marked; checked against the template', () => {
    const csv = 'file,categories,needs_detail,fields\na.jpg,dl_document,yes,dl_number;dl_validity\nb.jpg,spot_photo,no,-\nc.jpg,vehicle_photo,no,\n';
    const { rows, errors } = parseTruthCsv(csv, codes, fieldKeys);
    assert.deepEqual(errors, []);
    assert.deepEqual(rows.map((r) => r.fields), [['dl_number', 'dl_validity'], [], null]);
    assert.deepEqual(parseTruthCsv('a.jpg,dl_document,yes,dl_numbr\n', codes, fieldKeys).errors, ['line 1: unknown field dl_numbr']);
    assert.match(parseTruthCsv('a.jpg,dl_document,yes,dl_number\n', codes).errors[0], /no --template/);
  });

  test('csv cells with escaped quotes', () => {
    assert.deepEqual(splitCsvLine('"a ""b""",c,'), ['a "b"', 'c', '']);
  });
});

describe('scoring', () => {
  const truth = new Map<string, TruthRow>([
    ['1.jpg', { file: '1.jpg', codes: ['vehicle_photo'], needs_detail: false, fields: [] }],
    ['2.jpg', { file: '2.jpg', codes: ['vehicle_photo'], needs_detail: true, fields: null }],
    ['3.jpg', { file: '3.jpg', codes: ['rc_document'], needs_detail: true, fields: ['reg_number', 'reg_date'] }],
    ['4.jpg', { file: '4.jpg', codes: ['estimate'], needs_detail: true, fields: null }],
    ['5.jpg', { file: '5.jpg', codes: ['odometer_photo', 'chassis_engine_photo'], needs_detail: true, fields: ['odometer_at_entry'] }],
  ]);
  const ans = (code: string, confidence: number, needs_detail: boolean, fields: string[] = [], description: string | null = null) =>
    ({ ok: true, labels: [{ code, confidence }], fields: fields.map((key, i) => ({ key, confidence: 0.9 - i / 10 })), needs_detail, detail_reason: null, description });
  const records: RunRecord[] = [
    { file: '1.jpg', answer: ans('vehicle_photo', 0.95, false, ['spot_details'], 'Front bumper dented'), cost: 0.0001, latencyMs: 800 },
    { file: '2.jpg', answer: ans('vehicle_photo', 0.9, false), cost: 0.0001, latencyMs: 900 },     // missed detail
    { file: '3.jpg', answer: ans('rc_document', 0.85, true, ['reg_number', 'chassis_no']), cost: 0.0001, latencyMs: 1000 },
    { file: '4.jpg', answer: ans('job_card', 0.55, true), cost: 0.0001, latencyMs: 1200 },         // wrong document
    { file: '5.jpg', answer: null, error: 'HTTP 500', cost: 0, latencyMs: 3000 },                    // failed call
  ];
  const documentCodes = new Set(categories.filter((c) => c.default_evidence_type === 'document').map((c) => c.code));
  const s = summarise('test/model', records, truth, documentCodes);

  test('accuracy counts failed calls as wrong, split by documents and photos', () => {
    assert.equal(s.files, 5);
    assert.equal(s.failed, 1);
    assert.equal(s.accuracy, 3 / 5);
    assert.equal(s.documentAccuracy, 1 / 2);
    assert.equal(s.photoAccuracy, 2 / 3);
  });

  test('"needs detail": a failed call counts as flagged', () => {
    assert.deepEqual(s.detail, { flaggedRight: 3, missed: 1, extra: 0, recall: 3 / 4, precision: 1 });
  });

  test('field matches: micro precision / recall over marked files; failed calls match nothing', () => {
    // marked: 1 (truth none, predicted 1), 3 (truth 2, predicted 2, 1 right), 5 (truth 1, call failed)
    assert.deepEqual(s.fields, { files: 3, precision: 1 / 3, recall: 1 / 3, topHit: 1 / 2 });
  });

  test('description rate counts usable answers with a description', () => {
    assert.equal(s.descriptionRate, 1 / 4);
  });

  test('confidence routing: coverage and accuracy above each threshold', () => {
    assert.deepEqual(s.routing.find((r) => r.threshold === 0.8), { threshold: 0.8, coverage: 3 / 5, accuracy: 1 });
    assert.deepEqual(s.routing.find((r) => r.threshold === 0.5), { threshold: 0.5, coverage: 4 / 5, accuracy: 3 / 4 });
  });

  test('per-category scores, confusions, cost and pass marks', () => {
    const est = s.categories.find((c) => c.code === 'estimate')!;
    assert.deepEqual(est, { code: 'estimate', support: 1, recall: 0, precision: null });
    assert.deepEqual(s.confusions, [{ truth: 'estimate', predicted: 'job_card', count: 1 }]);
    assert.ok(Math.abs(s.cost.perImage! - 0.00008) < 1e-12);
    assert.ok(Math.abs(s.cost.perMonth90k! - 7.2) < 1e-9);
    assert.deepEqual(s.latency, { p50: 1000, p95: 3000 });
    assert.deepEqual(s.pass, { documents: false, photos: false, detailRecall: false, overall: false });
  });

  test('markdown report has no file names', () => {
    const md = renderMarkdown([s], { date: '2026-11-14', setup: 'single: one image per call at 384px', promptVersion: 'label-v1', marks: DEFAULT_PASS_MARKS });
    assert.ok(md.includes('| test/model | 5 | 1 | 60.0% | 50.0% | 66.7% | 33.3% | 33.3% | 75.0% | 1 | 25.0% |'));
    assert.ok(md.includes('| estimate | job_card | 1 |'));
    assert.ok(!md.includes('.jpg'));
  });
});

describe('collages (D36)', async () => {
  const { collageLayout, cellOrigin, parseLayout, badgeSvg, planCollages, parseCollageAnswer, collageMaxTokens, DEFAULT_CANVAS } = await import('../src/collage.ts');

  test('6×6 on the 1932-px canvas: 315-px cells, within Claude\'s high-resolution token limit', () => {
    const l = collageLayout(6);
    assert.equal(l.cell, 315);
    assert.equal(Math.ceil(DEFAULT_CANVAS / 28) ** 2 <= 4784, true);
    assert.deepEqual(cellOrigin(l, 0), { x: 6, y: 6 });
    assert.deepEqual(cellOrigin(l, 7), { x: 6 + 315 + 6, y: 6 + 315 + 6 });
    const last = cellOrigin(l, 35);
    assert.ok(last.x + l.cell <= DEFAULT_CANVAS && last.y + l.cell <= DEFAULT_CANVAS);
  });

  test('layout names', () => {
    assert.equal(parseLayout('single'), null);
    assert.equal(parseLayout('6x6'), 6);
    assert.throws(() => parseLayout('6x4'), /square grid/);
    assert.throws(() => parseLayout('9x9'), /2 to 8/);
  });

  test('badges draw digits as shapes (no fonts needed)', () => {
    const svg = badgeSvg(18);
    assert.match(svg, /^<svg /);
    assert.equal((svg.match(/<rect /g) ?? []).length, 1 + 2 + 7);   // background + "1" + "8"
    assert.ok(!svg.includes('<text'));
  });

  test('collages never mix cases and hold at most grid² cells', () => {
    const files = [...Array.from({ length: 40 }, (_, i) => `case01/${i}.jpg`), ...Array.from({ length: 3 }, (_, i) => `case02/${i}.jpg`)];
    const plan = planCollages(files, 6);
    assert.deepEqual(plan.map((c) => c.length), [36, 4, 3]);
    assert.ok(plan.every((c) => new Set(c.map((f) => f.split('/')[0])).size === 1));
  });

  test('collage prompt: numbered cells, every cell answered, cells judged on their own', () => {
    const p = buildSystemPrompt(categories, template, { collage: true });
    assert.ok(p.includes('yellow box at its top-left corner'));
    assert.ok(p.includes('{"images":[{"n":<cell number>,"labels"'));
    assert.ok(p.includes('Never use what is visible in a neighbouring cell'));
    assert.ok(!buildSystemPrompt(categories, template).includes('"images"'));
  });

  test('per-cell answers: missing, duplicate and out-of-range cells are reported, not guessed', () => {
    const cell = (n: number, code: string) => ({ n, labels: [{ code, confidence: 0.9 }], fields: [], needs_detail: false, description: null });
    const text = JSON.stringify({ images: [cell(1, 'vehicle_photo'), cell(2, 'rc_document'), cell(2, 'dl_document'), cell(4, 'spot_photo'), cell(9, 'other')] });
    const { answers, errors } = parseCollageAnswer(text, 4, codes, fieldKeys);
    assert.deepEqual(answers.map((a) => a?.labels[0].code ?? null), ['vehicle_photo', null, null, 'spot_photo']);
    assert.deepEqual(errors, ['cell 2 answered twice', 'cell number 9 out of range', 'cell 3 missing']);
    assert.deepEqual(parseCollageAnswer('not json', 2, codes).answers, [null, null]);
    assert.equal(collageMaxTokens(36), 1024 + 36 * 160);
  });
});
