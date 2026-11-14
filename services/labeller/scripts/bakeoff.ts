// Labelling bake-off (D34): run several vision models on the same office-labelled images and
// compare accuracy, "needs detail" recall, confidence routing, cost and latency.
//
//   node scripts/bakeoff.ts --images ~/toyam-samples/images --truth ~/toyam-samples/truth.csv \
//        --template ../../config/templates/igi-motor-od.yaml \
//        --models anthropic:claude-haiku-5-5,google:gemini-2.5-flash-lite,openrouter:qwen/qwen3-vl-8b-instruct
//
//   --layouts single,6x6 runs every model twice: one image per call, and numbered 6×6 collages (D36).
//
// Real case images contain personal data: keep them and the results OUTSIDE the repository, and
// send them to an external API only after the client has approved it (Q21). See README.md.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, relative, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { parse as parseYaml } from 'yaml';
import { buildSystemPrompt, parseLabelAnswer, templateFieldKeys, USER_INSTRUCTION, PROMPT_VERSION } from '../src/prompt.ts';
import type { LabelCategory, LabelTemplate } from '../src/prompt.ts';
import { callModel, parseModelRef, modelKey, API_KEY_ENV } from '../src/providers.ts';
import type { ImageInput, ModelRef } from '../src/providers.ts';
import { costOf, DEFAULT_PRICES } from '../src/prices.ts';
import { collageLayout, cellOrigin, badgeSvg, planCollages, collageInstruction, collageMaxTokens, parseCollageAnswer, parseLayout, DEFAULT_CANVAS } from '../src/collage.ts';
import type { Price } from '../src/prices.ts';
import { summarise, renderMarkdown, DEFAULT_PASS_MARKS } from '../src/score.ts';
import type { RunRecord, TruthRow } from '../src/score.ts';
import { parseTruthCsv } from '../src/truth.ts';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const REPO_ROOT = new URL('../../../', import.meta.url).pathname;

const { values: args } = parseArgs({
  options: {
    images: { type: 'string' },
    truth: { type: 'string' },
    models: { type: 'string', default: 'anthropic:claude-haiku-5-5,google:gemini-2.5-flash-lite' },
    categories: { type: 'string', default: join(REPO_ROOT, 'config/templates/_categories.yaml') },
    template: { type: 'string' },
    size: { type: 'string', default: '384' },
    layouts: { type: 'string', default: 'single' },
    'collage-px': { type: 'string', default: String(DEFAULT_CANVAS) },
    concurrency: { type: 'string', default: '4' },
    limit: { type: 'string' },
    out: { type: 'string' },
    prices: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!args.images) fail('--images <folder> is required');
const imagesDir = resolve(args.images);
const longEdge = Number(args.size);
const concurrency = Math.max(1, Number(args.concurrency));
const outDir = resolve(args.out ?? join(process.cwd(), 'bakeoff-results', new Date().toISOString().replace(/[:.]/g, '-')));
if (outDir.startsWith(resolve(REPO_ROOT)) && !outDir.includes('/bakeoff-results')) {
  fail(`Refusing to write results inside the repository (${outDir}); use a folder outside it or ./bakeoff-results (ignored by git).`);
}

// ---------------------------------------------------------------------------- inputs
const categories = parseYaml(readFileSync(args.categories!, 'utf8')) as LabelCategory[];
const allowed = new Set(categories.map((c) => c.code));
const documentCodes = new Set(categories.filter((c) => c.default_evidence_type === 'document').map((c) => c.code));
// With a template, the model also returns the report fields each image is evidence for (D35).
const template = args.template ? parseYaml(readFileSync(args.template, 'utf8')) as LabelTemplate : undefined;
const allowedFields = templateFieldKeys(template);
const system = buildSystemPrompt(categories, template);
const collageSystem = buildSystemPrompt(categories, template, { collage: true });
const layouts = args.layouts!.split(',').map((x) => x.trim()).map((spec) => ({ spec, grid: parseLayout(spec) }));
const collagePx = Number(args['collage-px']);

const truth = new Map<string, TruthRow>();
if (args.truth) {
  const { rows, errors } = parseTruthCsv(readFileSync(args.truth, 'utf8'), allowed, template ? allowedFields : undefined);
  if (errors.length) fail(`Ground truth has errors:\n  ${errors.join('\n  ')}`);
  for (const r of rows) truth.set(r.file, r);
}

let files = args.truth ? [...truth.keys()] : walk(imagesDir).map((f) => relative(imagesDir, f));
files = files.filter((f) => {
  if (IMAGE_EXT.has(extname(f).toLowerCase())) return true;
  console.warn(`skipped (not an image): ${f}`);
  return false;
});
if (args.limit) files = files.slice(0, Number(args.limit));
if (!files.length) fail('No images to label.');

const prices: Record<string, Price> = args.prices ? { ...DEFAULT_PRICES, ...JSON.parse(readFileSync(args.prices, 'utf8')) } : DEFAULT_PRICES;
const models: ModelRef[] = args.models!.split(',').map((s) => parseModelRef(s.trim(), process.env.LOCAL_VLM_BASE_URL));

// ---------------------------------------------------------------------------- resize once
console.log(`Preparing ${files.length} images at ${longEdge}px …`);
const images = new Map<string, ImageInput>();
let bytes = 0;
for (const f of files) {
  const { data, info } = await sharp(join(imagesDir, f)).rotate()
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
  images.set(f, { base64: data.toString('base64'), mimeType: 'image/jpeg', longEdge: Math.max(info.width, info.height) });
  bytes += data.length;
}
console.log(`  ${(bytes / 1024 / files.length).toFixed(0)} KB per image on average.`);

// ---------------------------------------------------------------------------- collages (built once per layout)
interface Collage { id: string; files: string[]; image: ImageInput }
const collages = new Map<number, Collage[]>();
mkdirSync(outDir, { recursive: true });
for (const { spec, grid } of layouts) {
  if (grid === null) continue;
  const layout = collageLayout(grid, collagePx);
  const plan = planCollages(files, grid);
  const dir = join(outDir, 'collages', spec);
  mkdirSync(dir, { recursive: true });
  const built: Collage[] = [];
  for (const [i, group] of plan.entries()) {
    const parts = [];
    for (const [j, f] of group.entries()) {
      const { x, y } = cellOrigin(layout, j);
      const cell = await sharp(join(imagesDir, f)).rotate()
        .resize({ width: layout.cell, height: layout.cell, fit: 'contain', background: '#000' }).toBuffer();
      parts.push({ input: cell, left: x, top: y });
      parts.push({ input: Buffer.from(badgeSvg(j + 1, Math.max(24, Math.round(layout.cell / 9)))), left: x, top: y });
    }
    const data = await sharp({ create: { width: layout.canvas, height: layout.canvas, channels: 3, background: '#000' } })
      .composite(parts).jpeg({ quality: 85 }).toBuffer();
    const id = `${spec}-${String(i + 1).padStart(4, '0')}`;
    writeFileSync(join(dir, `${id}.jpg`), data);   // for checking mix-ups; contains personal data, stays outside git
    built.push({ id, files: group, image: { base64: data.toString('base64'), mimeType: 'image/jpeg', longEdge: layout.canvas } });
  }
  collages.set(grid, built);
  console.log(`  ${spec}: ${built.length} collages of up to ${grid * grid} cells, ${layout.cell}px per cell.`);
}

const runs = models.flatMap((ref) => layouts.map((l) => ({ ref, ...l })));
if (args['dry-run']) {
  const calls = runs.reduce((n, r) => n + (r.grid === null ? files.length : collages.get(r.grid)!.length), 0);
  console.log(`Dry run: ${runs.length} model × layout runs, ${calls} calls. Nothing sent. Collages written to ${join(outDir, 'collages')}.`);
  console.log(`System prompt (${system.length} characters, ~${Math.round(system.length / 4)} tokens):\n\n${system}`);
  process.exit(0);
}

for (const m of models) {
  if (m.provider !== 'local' && !process.env[API_KEY_ENV[m.provider]]) fail(`Set ${API_KEY_ENV[m.provider]} for ${modelKey(m)}.`);
}

// ---------------------------------------------------------------------------- run
const summaries = [];
for (const { ref, spec, grid } of runs) {
  const key = modelKey(ref);
  const label = `${key} · ${spec}`;
  const apiKey = process.env[API_KEY_ENV[ref.provider]] ?? '';
  const jsonl = join(outDir, `${key.replace(/[^a-z0-9.-]+/gi, '_')}.${spec}.jsonl`);
  writeFileSync(jsonl, '');
  const records: RunRecord[] = [];
  let done = 0;
  console.log(`\n${label}`);

  if (grid === null) {
    await pool(files, concurrency, async (file) => {
      const started = Date.now();
      let record: RunRecord;
      try {
        const reply = await callModel(fetch, ref, apiKey, system, USER_INSTRUCTION, images.get(file)!);
        const answer = parseLabelAnswer(reply.text, allowed, allowedFields);
        record = { file, answer, cost: costOf(key, reply.usage, prices), latencyMs: Date.now() - started, ...(answer.error ? { error: answer.error } : {}) };
        appendFileSync(jsonl, JSON.stringify({ ...record, usage: reply.usage }) + '\n');
      } catch (e) {
        record = { file, answer: null, error: (e as Error).message, cost: 0, latencyMs: Date.now() - started };
        appendFileSync(jsonl, JSON.stringify(record) + '\n');
      }
      records.push(record);
      if (++done % 25 === 0 || done === files.length) process.stdout.write(`  ${done}/${files.length}\n`);
    });
  } else {
    const list = collages.get(grid)!;
    await pool(list, concurrency, async (c) => {
      const started = Date.now();
      const cells = c.files.length;
      try {
        const reply = await callModel(fetch, ref, apiKey, collageSystem, collageInstruction(cells), c.image,
                                      { maxOutputTokens: collageMaxTokens(cells) });
        const latencyMs = Date.now() - started;
        const cost = costOf(key, reply.usage, prices);
        const { answers, errors } = parseCollageAnswer(reply.text, cells, allowed, allowedFields);
        c.files.forEach((file, i) => {
          const answer = answers[i];
          // The collage's cost and latency are shared by its cells.
          const record: RunRecord = { file, answer, cost: cost === null ? null : cost / cells, latencyMs,
            ...(answer === null ? { error: `cell ${i + 1} missing or unusable` } : answer.error ? { error: answer.error } : {}) };
          records.push(record);
          appendFileSync(jsonl, JSON.stringify({ ...record, collage: c.id, cell: i + 1 }) + '\n');
        });
        if (errors.length) appendFileSync(jsonl, JSON.stringify({ collage: c.id, errors, usage: reply.usage }) + '\n');
      } catch (e) {
        for (const file of c.files) {
          const record: RunRecord = { file, answer: null, error: (e as Error).message, cost: 0, latencyMs: Date.now() - started };
          records.push(record);
          appendFileSync(jsonl, JSON.stringify({ ...record, collage: c.id }) + '\n');
        }
      }
      if (++done % 5 === 0 || done === list.length) process.stdout.write(`  ${done}/${list.length} collages\n`);
    });
  }

  if (truth.size) summaries.push(summarise(label, records, truth, documentCodes));
  else console.log(`  labels written to ${jsonl} (no ground truth, no score)`);
}

if (summaries.length) {
  const setup = layouts.map((l) => l.grid === null
    ? `single: one image per call at ${longEdge}px (long edge)`
    : `${l.spec}: numbered collages on a ${collagePx}px canvas, ${collageLayout(l.grid, collagePx).cell}px per cell`).join('; ');
  const md = renderMarkdown(summaries, { date: new Date().toISOString().slice(0, 10), setup, promptVersion: PROMPT_VERSION, marks: DEFAULT_PASS_MARKS });
  writeFileSync(join(outDir, 'summary.md'), md);
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summaries, null, 2));
  console.log(`\n${md}`);
}
console.log(`Results: ${outDir}`);

// ---------------------------------------------------------------------------- helpers
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  }).sort();
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}
