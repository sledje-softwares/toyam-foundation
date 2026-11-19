// Contract test against the real Python sidecar process in its `fake` engine mode (no PaddleOCR needed):
// HTTP shape, auth, type and size checks, and the Node adapter parsing its answer. Skipped without python3.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHttpEngine, OcrHttpError } from '../src/ocr-engine.ts';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const port = 18866 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

describe('ocr sidecar (fake engine)', { skip: hasPython ? false : 'python3 not installed' }, () => {
  let proc: ChildProcess;
  before(async () => {
    proc = spawn('python3', ['-I', fileURLToPath(new URL('../ocr-sidecar/app.py', import.meta.url))], {
      env: { PATH: process.env.PATH ?? '', PORT: String(port), OCR_SIDECAR_ENGINE: 'fake', OCR_TOKEN: 'tok', OCR_MAX_BYTES: '1000' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('sidecar did not start');
  });
  after(() => { proc?.kill(); });

  test('health', async () => {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, engine: 'fake', engine_version: '0' });
  });

  test('the Node adapter reads a page from the sidecar', async () => {
    const out = await createHttpEngine({ url: base, token: 'tok' }).read(new TextEncoder().encode('jpeg'), 'image/jpeg', { maxPages: 1 });
    assert.equal(out?.engine, 'fake');
    assert.equal(out?.pages[0].text, 'MH 12 AB 1234');
    assert.deepEqual(out?.pages[0].blocks[0].bbox, [0, 0, 100, 20]);
  });

  test('refuses a wrong token (401), an unsupported type (415) and a too large body (413), not retryable', async () => {
    const bytes = new TextEncoder().encode('x');
    const code = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e instanceof OcrHttpError ? [e.status, e.retryable] : e));
    assert.deepEqual(await code(createHttpEngine({ url: base, token: 'wrong' }).read(bytes, 'image/jpeg', { maxPages: 1 })), [401, false]);
    assert.deepEqual(await code(createHttpEngine({ url: base, token: 'tok' }).read(bytes, 'text/html', { maxPages: 1 })), [415, false]);
    assert.deepEqual(await code(createHttpEngine({ url: base, token: 'tok' }).read(new Uint8Array(2000), 'image/png', { maxPages: 1 })), [413, false]);
  });
});
