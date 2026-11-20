// Intake parser tests on anonymised fixtures shaped like the real insurer mails.
// Run: npm test -w services/intake   (Node >= 22.18 runs TypeScript directly)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import PostalMime from 'postal-mime';
import { htmlRows, processEmail } from '../../../supabase/functions/_shared/intake/index.ts';
import { fromPostalMime } from '../../../supabase/functions/_shared/intake/mime.ts';
import { buildIndex, findLabel } from '../../../supabase/functions/_shared/intake/table.ts';
import type { IntakeDecision } from '../../../supabase/functions/_shared/intake/types.ts';
import { configFromYaml } from '../src/template-config.ts';

const cfg = configFromYaml();

async function decide(fixture: string, extras: { threadId?: string } = {}): Promise<IntakeDecision> {
  const raw = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8');
  const parsed = await fromPostalMime(await PostalMime.parse(raw), extras);
  return processEmail(parsed, cfg, { path: `emails/test/${fixture}`, sha256: 'f'.repeat(64) });
}

const v = (d: IntakeDecision, key: string) => d.fields[key]?.value;

describe('html helpers', () => {
  it('returns innermost rows, keeps empty cells and decodes entities', () => {
    const rows = htmlRows(`<table><tr><td><table><tr><td>A&amp;B</td><td></td><td>C&nbsp;D</td></tr></table></td></tr></table>`);
    assert.deepEqual(rows, [['A&B', '', 'C D']]);
  });
  it('finds a label only inside the requested block', () => {
    const idx = buildIndex([['Intimator Details'], ['Mobile Number', '111'], ['Insured Details'], ['Mobile Number', '222']]);
    assert.equal(findLabel(idx, 'Mobile Number')?.value, '111');
    assert.equal(findLabel(idx, 'Mobile Number', 'Insured Details')?.value, '222');
  });
  it('reads "Label: value" written in one cell', () => {
    const idx = buildIndex([['Policy Number: 123 456']]);
    assert.equal(findLabel(idx, 'Policy Number')?.value, '123 456');
  });
});

describe('templates from config/templates', () => {
  it('loads both drafted templates with intake fields', () => {
    const keys = cfg.templates.map((t) => `${t.insurer_code}/${t.variant}`).sort();
    assert.deepEqual(keys, ['ICL/od', 'IGI/od', 'IGI/theft']);
    for (const t of cfg.templates) assert.ok(t.fields.some((f) => f.key === 'insurer_claim_no' && f.required));
  });
});

describe('IndusInd (Reliance) motor OD', () => {
  it('new case: template matched, required fields found, action create_case', async () => {
    const d = await decide('igi-new-od.eml');
    assert.equal(d.action, 'create_case');
    assert.equal(d.classification, 'new_case');
    assert.equal(d.template_id, 'tpl-IGI-motor-od');
    assert.equal(d.claim_no, '3100000001');
    assert.deepEqual(d.missing_required, []);
    assert.equal(v(d, 'insured_name'), 'Ravi Sharma');
    assert.equal(d.fields.insurer_claim_no.source, 'subject');
    assert.equal(v(d, 'policy_no'), '000000000000000001');
    assert.equal(v(d, 'vehicle_no'), 'MP-00-XX-0001');
    assert.equal(v(d, 'vehicle_class'), 'TWL');
  });
  it('reads block-scoped labels (insured mobile, not the intimator; driver "Name")', async () => {
    const d = await decide('igi-new-od.eml');
    assert.equal(v(d, 'insured_mobile'), '9000000001');
    assert.equal(v(d, 'driver_name'), 'Amit Sharma');
    assert.equal(v(d, 'policy_address'), 'House 1, Test Nagar, SATNA, MADHYA PRADESH, 485001');
    assert.equal(v(d, 'garage_address'), 'Main Road, SATNA, 485001');
  });
  it('joins date and time; keeps entities decoded; multi-line labels match', async () => {
    const d = await decide('igi-new-od.eml');
    assert.equal(v(d, 'loss_datetime'), '27-Sep-2026 12:40');
    assert.equal(v(d, 'intimation_datetime'), '05-Oct-2026 11:04');
    assert.equal(v(d, 'cause_of_loss_intimated'), 'Vehicle skidded on the wet road & hit the divider');
    assert.equal(v(d, 'policy_period'), '14-Feb-2026, 13-Feb-2027');
    assert.equal(v(d, 'vehicle_make'), 'HONDA');
  });
  it('captures the investigation points', async () => {
    const d = await decide('igi-new-od.eml');
    const points = v(d, 'investigation_points') ?? '';
    assert.match(points, /^1\. Verify the identity of the actual driver\./);
    assert.match(points, /3\. Collect all relevant police documents/);
    assert.doesNotMatch(points, /Claim Intimation Details/);
  });
  it('signature logo is not evidence', async () => {
    const d = await decide('igi-new-od.eml');
    assert.equal(d.attachments.length, 1);
    assert.equal(d.attachments[0].evidence, false);
  });
  it('THEFT subject matches the theft template and fills the shared fields', async () => {
    const d = await decide('igi-new-theft.eml');
    assert.ok(d.action === 'create_case' || d.action === 'review');
    assert.equal(d.insurer_id, 'ins-IGI');
    assert.equal(d.template_id, 'tpl-IGI-motor-theft');
    assert.equal(d.claim_no, '3200000002');
    assert.equal(v(d, 'insured_name'), 'Mohan Lal');
    assert.ok(v(d, 'policy_no'), 'policy number read from the table');
    assert.equal(v(d, 'vehicle_class'), 'TWL');
    assert.match(v(d, 'investigation_points') ?? '', /^1\. Verify the identity/);
  });
  it('missing required field goes to review', async () => {
    const d = await decide('igi-missing-policy.eml');
    assert.equal(d.action, 'review');
    assert.deepEqual(d.missing_required, ['policy_no']);
    assert.equal(v(d, 'insured_name'), 'Sita Devi');
  });
  it('plain-text intimation is read with lower confidence', async () => {
    const d = await decide('igi-text-only.eml');
    assert.equal(d.action, 'create_case');
    assert.equal(v(d, 'policy_no'), '000000000000000004');
    assert.equal(v(d, 'insured_mobile'), '9000000044');
    assert.equal(d.fields.policy_no.source, 'text');
    assert.ok(d.fields.policy_no.confidence < 0.9);
  });
  it('insurer reply on the thread: attach to case, reminder, attachment is evidence', async () => {
    const d = await decide('igi-reply-reminder.eml');
    assert.equal(d.action, 'attach_to_case');
    assert.equal(d.classification, 'reminder');
    assert.equal(d.in_reply_to, 'igi-0001@indusindinsurance.com');
    assert.equal(d.claim_no, '3100000001');
    assert.deepEqual(d.attachments.map((a) => [a.filename, a.evidence]), [['Claim form.pdf', true]]);
    assert.match(d.attachments[0].sha256 ?? '', /^[0-9a-f]{64}$/);
  });
});

describe('ICICI Lombard motor OD', () => {
  it('new case with insurer attachments as evidence', async () => {
    const d = await decide('icl-new-od.eml');
    assert.equal(d.action, 'create_case');
    assert.equal(d.claim_no, 'MOT00000001');
    assert.equal(v(d, 'insured_name'), 'SAMPLE TRADERS');
    assert.equal(v(d, 'insurer_internal_claim_no'), '17000001');
    assert.equal(v(d, 'policy_no'), '3005/O/000000001/00/B00');
    assert.equal(v(d, 'vehicle_no'), 'MP00XX0002');
    assert.equal(v(d, 'make_model'), 'ATHER, 450X');
    assert.equal(v(d, 'date_of_loss'), '17-OCT-2026');
    assert.equal(v(d, 'time_of_accident'), '11:30');
    assert.equal(v(d, 'driver_name'), 'test driver');
    assert.equal(v(d, 'garage_name'), 'TEST AVENUES PVT LTD');
    assert.deepEqual(d.cc, ['manager.test@icicilombard.com']);
    assert.deepEqual(
      d.attachments.map((a) => a.evidence),
      [false, true, true, true],
      'inline signature skipped; vehicle photo, DL and e-claim kept',
    );
  });
  it('insured address comes from the insured block, not garage or loss', async () => {
    const d = await decide('icl-new-od.eml');
    assert.equal(v(d, 'insured_actual_address'), 'H NO. 1 TEST MARKET, BHOPAL, MADHYA PRADESH, 462001');
    assert.equal(v(d, 'contact_person'), '9000000002, 9000000003');
  });
  it('red-flag points are captured from the HTML body', async () => {
    const d = await decide('icl-new-od.eml');
    const points = v(d, 'investigation_points') ?? '';
    assert.match(points, /Driver Verification/);
    assert.match(points, /CCTV and Other Surveillance/);
    assert.doesNotMatch(points, /Intimation Sheet/);
  });
});

describe('other senders', () => {
  it('mail from the firm is internal and never creates a case', async () => {
    const d = await decide('internal-reply.eml');
    assert.equal(d.action, 'internal');
    assert.equal(d.is_internal, true);
  });
  it('unknown sender is unmatched', async () => {
    const d = await decide('unknown-sender.eml');
    assert.equal(d.action, 'unmatched');
    assert.equal(d.insurer_id, null);
  });
  it('Gmail thread id from the relay is kept', async () => {
    const d = await decide('igi-new-od.eml', { threadId: '1879908795976617680' });
    assert.equal(d.thread_id, '1879908795976617680');
    assert.equal(d.message_id, 'igi-0001@indusindinsurance.com');
  });
});

describe('template files', () => {
  it('every template in config/templates validates against the category list', async () => {
    const { readYaml, templateFiles, validateTemplate, TEMPLATES_DIR } = await import('../src/template-config.ts');
    const codes = new Set(readYaml<Array<{ code: string }>>(`${TEMPLATES_DIR}_categories.yaml`).map((c) => c.code));
    for (const f of templateFiles()) assert.deepEqual(validateTemplate(readYaml(f), codes), [], f);
  });
});
