import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, describeConfig } from '../src/config.ts';

const base = { SUPABASE_URL: 'http://127.0.0.1:54321/', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };

describe('config', () => {
  test('requires the Supabase URL and service-role key', () => {
    const { errors } = loadConfig({});
    assert.deepEqual(errors, ['SUPABASE_URL is required', 'SUPABASE_SERVICE_ROLE_KEY is required']);
  });

  test('no ANTHROPIC_API_KEY and no LABEL_PROVIDER: labelling is off (jobs stay queued), other stages run', () => {
    const { config, errors } = loadConfig(base);
    assert.deepEqual(errors, []);
    assert.equal(config.label.mode, 'off');
    assert.match(config.label.offReason!, /no ANTHROPIC_API_KEY/);
    assert.deepEqual(config.stages, ['text_extract', 'label', 'ocr', 'field_suggest']);
    assert.equal(config.supabaseUrl, 'http://127.0.0.1:54321');
  });

  test('with ANTHROPIC_API_KEY: Haiku 5.5 first, Sonnet 5.5 escalation, threshold 0.6 (D37, 2026-11-26 test)', () => {
    const { config } = loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-test' });
    assert.equal(config.label.mode, 'api');
    assert.deepEqual(config.label.primary, { provider: 'anthropic', model: 'claude-haiku-5-5' });
    assert.deepEqual(config.label.escalation, { provider: 'anthropic', model: 'claude-sonnet-5-5' });
    assert.equal(config.label.threshold, 0.6);
    assert.equal(config.label.effort, null, 'model default effort unless LABEL_EFFORT is set');
  });

  test('LABEL_PROVIDER=anthropic without its key refuses to label instead of skipping', () => {
    const { config, warnings, errors } = loadConfig({ ...base, LABEL_PROVIDER: 'anthropic' });
    assert.deepEqual(errors, []);
    assert.equal(config.label.mode, 'off');
    assert.match(warnings.join(), /ANTHROPIC_API_KEY not set/);
  });

  test('escalation can be turned off or pointed at another provider; threshold and effort set', () => {
    let c = loadConfig({ ...base, ANTHROPIC_API_KEY: 'k', LABEL_ESCALATION_MODEL: 'off', LABEL_ESCALATION_THRESHOLD: '0.55', LABEL_EFFORT: 'low' }).config;
    assert.equal(c.label.escalation, null);
    assert.equal(c.label.threshold, 0.55);
    assert.equal(c.label.effort, 'low');
    c = loadConfig({ ...base, LABEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', LABEL_ESCALATION_MODEL: 'google:gemini-3.1-flash-lite' }).config;
    assert.equal(c.label.mode, 'off', 'escalation provider key missing');
    c = loadConfig({ ...base, LABEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'g', LABEL_ESCALATION_MODEL: 'google:gemini-3.1-flash-lite' }).config;
    assert.deepEqual(c.label.escalation, { provider: 'google', model: 'gemini-3.1-flash-lite' });
  });

  test('other providers need LABEL_MODEL; unknown providers are an error', () => {
    assert.match(loadConfig({ ...base, LABEL_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }).errors.join(), /LABEL_MODEL is required/);
    const ok = loadConfig({ ...base, LABEL_PROVIDER: 'openai', OPENAI_API_KEY: 'k', LABEL_MODEL: 'gpt-5-nano' }).config;
    assert.equal(ok.label.mode, 'api');
    assert.equal(ok.label.escalation, null);
    assert.match(loadConfig({ ...base, LABEL_PROVIDER: 'skynet' }).errors.join(), /LABEL_PROVIDER must be one of/);
  });

  test('manual mode needs a folder', () => {
    assert.match(loadConfig({ ...base, LABEL_PROVIDER: 'manual' }).errors.join(), /LABEL_MANUAL_DIR/);
    const c = loadConfig({ ...base, LABEL_PROVIDER: 'manual', LABEL_MANUAL_DIR: '/tmp/x' }).config;
    assert.equal(c.label.mode, 'manual');
    assert.equal(c.concurrency, 8, 'more slots while answers are awaited');
  });

  test('OCR engine http needs OCR_URL; numbers are validated; stages can be limited', () => {
    assert.match(loadConfig({ ...base, OCR_ENGINE: 'http' }).errors.join(), /OCR_URL/);
    assert.match(loadConfig({ ...base, OCR_ENGINE: 'tesseract' }).errors.join(), /OCR_ENGINE must be none or http/);
    assert.match(loadConfig({ ...base, PIPELINE_CONCURRENCY: '0' }).errors.join(), /PIPELINE_CONCURRENCY/);
    assert.match(loadConfig({ ...base, PIPELINE_STAGES: 'label,ocr2' }).errors.join(), /unknown stage "ocr2"/);
    assert.deepEqual(loadConfig({ ...base, PIPELINE_STAGES: 'ocr, field_suggest' }).config.stages, ['ocr', 'field_suggest']);
  });

  test('R2 uses the read-only token; the summary never contains secrets', () => {
    const { config } = loadConfig({ ...base, ANTHROPIC_API_KEY: 'sk-secret', R2_ACCOUNT_ID: 'acc', R2_BUCKET: 'b', R2_READ_ACCESS_KEY_ID: 'rk', R2_READ_SECRET_ACCESS_KEY: 'rs', R2_SECRET_ACCESS_KEY: 'write' });
    assert.deepEqual(config.r2, { accountId: 'acc', bucket: 'b', accessKeyId: 'rk', secretAccessKey: 'rs' });
    const s = JSON.stringify(describeConfig(config));
    for (const secret of ['sk-secret', 'service-key', 'rs', 'write']) assert.ok(!s.includes(`"${secret}"`) && !s.includes(secret + '"'), secret);
    assert.match(s, /"r2_configured":true/);
  });
});
