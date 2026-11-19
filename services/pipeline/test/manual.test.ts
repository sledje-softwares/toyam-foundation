import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualModel, ManualTimeout, Aborted, assertOutsideRepo } from '../src/models.ts';
import type { LabelRequest } from '../src/models.ts';

const req = (over: Partial<LabelRequest> = {}): LabelRequest => ({
  requestId: 'e1.v1',
  system: 'SYSTEM PROMPT',
  instruction: 'Label this image.',
  image: { base64: Buffer.from('jpeg-bytes').toString('base64'), mimeType: 'image/jpeg', longEdge: 384 },
  meta: { evidence_id: 'e1', template_id: 'tpl1', pipeline_version: 'v1', categories: ['vehicle_photo'], fields: ['reg_number'] },
  ...over,
});

const fastSleep = () => new Promise<void>((r) => setTimeout(r, 5));

describe('manual stand-in model', () => {
  test('writes the request (prompt, image, meta) and returns the answer file once written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manual-'));
    const m = createManualModel({ dir, pollMs: 5, sleep: fastSleep });
    const pending = m.label(req());
    await new Promise((r) => setTimeout(r, 30));
    const meta = JSON.parse(await readFile(join(dir, 'requests', 'e1.v1.json'), 'utf8'));
    assert.equal(meta.evidence_id, 'e1');
    assert.deepEqual(meta.categories, ['vehicle_photo']);
    assert.equal(meta.answer_file, 'answers/e1.v1.json');
    assert.equal(await readFile(join(dir, meta.prompt_file), 'utf8'), 'SYSTEM PROMPT');
    assert.equal(await readFile(join(dir, meta.attachment), 'utf8'), 'jpeg-bytes');
    await writeFile(join(dir, 'answers', 'e1.v1.json'), JSON.stringify({ labels: [{ code: 'vehicle_photo', confidence: 0.9 }], needs_detail: false }));
    const reply = await pending;
    assert.equal(reply.model, 'manual/human');
    assert.equal(reply.usage, null);
    assert.equal(JSON.parse(reply.text).labels[0].code, 'vehicle_photo');
    assert.deepEqual(await readdir(join(dir, 'requests')), [], 'request moved to done/');
    assert.equal((await readdir(join(dir, 'done'))).length, 3);
  });

  test('the answer may name the model that answered; answers.json works too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manual-'));
    await writeFile(join(dir, 'answers.json'), JSON.stringify({ 'e2.v1': { model: 'anthropic/claude-opus-5-5', labels: [{ code: 'other', confidence: 0.5 }] } }));
    const m = createManualModel({ dir, pollMs: 5, sleep: fastSleep, name: 'agent' });
    const reply = await m.label(req({ requestId: 'e2.v1', image: null, instruction: 'pdf text' }));
    assert.equal(reply.model, 'anthropic/claude-opus-5-5');
    const bad = await (async () => {
      await writeFile(join(dir, 'answers.json'), JSON.stringify({ 'e3.v1': { model: 'not a model; drop table', labels: [] } }));
      return m.label(req({ requestId: 'e3.v1' }));
    })();
    assert.equal(bad.model, 'manual/agent', 'invalid model names fall back to manual/<name>');
  });

  test('times out (the job fails and is re-queued) and stops when aborted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'manual-'));
    let t = 0;
    const m = createManualModel({ dir, pollMs: 5, timeoutMs: 20, now: () => (t += 10), sleep: fastSleep });
    await assert.rejects(m.label(req()), ManualTimeout);
    const ctrl = new AbortController();
    const m2 = createManualModel({ dir, pollMs: 5, sleep: fastSleep });
    const p = m2.label(req({ requestId: 'e9.v1', signal: ctrl.signal }));
    setTimeout(() => ctrl.abort(), 20);
    await assert.rejects(p, Aborted);
  });

  test('refuses a folder inside the repository (it holds case images)', () => {
    assert.throws(() => assertOutsideRepo(new URL('../tmp-manual', import.meta.url).pathname), /outside the repository/);
    assert.doesNotThrow(() => assertOutsideRepo(tmpdir()));
  });
});
