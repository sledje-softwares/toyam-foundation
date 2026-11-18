// LOCAL STACK ONLY: adds N synthetic photos to a seeded case, stored the way insurer email attachments are
// (bucket email-raw, evidence storage_backend 'supabase', capture_source 'email_attachment'), so the office pages,
// the browser file cache and report generation have real files to show. The seeded evidence rows point at files that
// do not exist; these do.
//
//   npm run dev:photos -w services/intake -- --case INV-2026-000008 --count 30 [--dry-run]
//
// Reads the local API URL and service-role key from `npx -y supabase@3.1.0 status -o env` and refuses to run
// unless the API URL is localhost / 127.0.0.1. The key never leaves this process and is never printed.
//
// Per photo: PNG (1600×1200, numbered and coloured, no personal data) → Storage email-raw at
// emails/dev-photos/{case_id}/{sha256}.png → email_attachments row (is_evidence) on one synthetic "additional docs"
// email of the case → evidence row with the same columns private.add_email_evidence() writes. The insert trigger labels
// each file by its name (filename_rule: "Front View(1).png" → Vehicle photo, "Spot(1).png" → spot photo, …), so the
// files land in the photo sections of the IGI / ICL layouts. Their queued pipeline jobs are marked skipped (no pipeline
// runs locally). Idempotent: images are deterministic, evidence is unique per (case_id, sha256), existing rows and
// objects are reused.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDevPhoto } from './dev-photos-lib.ts';

const BUCKET = 'email-raw';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const caseRef = arg('case');
const count = Number(arg('count') ?? '30');
const dryRun = process.argv.includes('--dry-run');
if (!caseRef || !/^[A-Z]{2,5}-\d{4}-\d{6}$/.test(caseRef)) {
  console.error('Usage: npm run dev:photos -w services/intake -- --case INV-2026-000008 [--count 30] [--dry-run]');
  process.exit(2);
}
if (!Number.isInteger(count) || count < 1 || count > 200) {
  console.error('--count must be 1-200');
  process.exit(2);
}

function localEnv(): { url: string; key: string } {
  let out: string;
  try {
    out = execFileSync('npx', ['-y', 'supabase@3.1.0', 'status', '-o', 'env'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    console.error('Could not read `supabase status`. Is the local stack running (npx -y supabase@3.1.0 start)?');
    process.exit(1);
  }
  const env = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^([A-Z0-9_]+)="(.*)"$/.exec(line.trim());
    if (m) env.set(m[1], m[2]);
  }
  const url = env.get('API_URL') ?? '';
  const key = env.get('SERVICE_ROLE_KEY') ?? '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // checked below
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.error(`Refusing to run: the API URL is not local (${url || 'missing'}). This script is for the local stack only.`);
    process.exit(1);
  }
  if (!key) {
    console.error('No SERVICE_ROLE_KEY in `supabase status -o env`.');
    process.exit(1);
  }
  return { url: url.replace(/\/$/, ''), key };
}

const { url: API, key: KEY } = dryRun ? { url: 'http://127.0.0.1', key: '' } : localEnv();
const headers = (extra: Record<string, string> = {}) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, ...extra });

async function rest<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
  const res = await fetch(`${API}/rest/v1/${path}`, {
    method,
    headers: headers({ 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function upload(path: string, bytes: Uint8Array): Promise<'stored' | 'exists'> {
  const res = await fetch(`${API}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'image/png', 'x-upsert': 'false' }),
    body: bytes,
  });
  if (res.ok) return 'stored';
  const text = await res.text();
  // content-addressed path: an existing object has the same bytes
  if (res.status === 409 || /exists|duplicate/i.test(text)) return 'exists';
  throw new Error(`upload ${path}: ${res.status} ${text.slice(0, 300)}`);
}

const q = encodeURIComponent;

async function main(): Promise<void> {
  const photos = Array.from({ length: count }, (_, i) => {
    const p = renderDevPhoto(i, caseRef!);
    return { ...p, sha256: createHash('sha256').update(p.png).digest('hex') };
  });
  if (dryRun) {
    for (const p of photos) console.log(`${p.fileName.padEnd(24)} ${p.category.padEnd(22)} ${(p.png.length / 1024).toFixed(0).padStart(5)} KB  ${p.sha256.slice(0, 12)}`);
    console.log(`dry run: ${photos.length} images generated, nothing stored`);
    return;
  }

  const cases = await rest<{ id: string; case_ref: string; status: string; insurer_id: string; template_id: string | null; insurers: { code: string; reply_to_email: string | null } | null }[]>(
    'GET', `cases?case_ref=eq.${q(caseRef!)}&select=id,case_ref,status,insurer_id,template_id,insurers(code,reply_to_email)`);
  const c = cases[0];
  if (!c) throw new Error(`No case ${caseRef} on the local stack (seeded cases: supabase/README.md "Seed data").`);

  // One synthetic insurer email per case carries the attachments (email_attachments needs an email).
  const msgId = `dev-photos-${c.case_ref}@dev-photos.invalid`;
  let email = (await rest<{ id: string }[]>('GET', `emails?gmail_message_id=eq.${q(msgId)}&select=id`))[0];
  if (!email) {
    email = (await rest<{ id: string }[]>('POST', 'emails?select=id', {
      gmail_message_id: msgId,
      from_address: c.insurers?.reply_to_email ?? 'claims@insurer.example',
      to_addresses: ['cases@investigation.example'],
      subject: `Additional photos ${c.case_ref} (synthetic dev data)`,
      body_text: 'Synthetic test images added by services/intake/scripts/dev-photos.ts on the local stack. No real data.',
      received_at: new Date().toISOString(),
      classification: 'additional_docs',
      status: 'processed',
      insurer_id: c.insurer_id,
      case_id: c.id,
      template_id: c.template_id,
      processed_at: new Date().toISOString(),
      parser_version: 'dev-photos',
    }, 'return=representation'))[0];
  }

  let stored = 0, reused = 0, created = 0;
  const evidenceIds: string[] = [];
  for (const p of photos) {
    const path = `emails/dev-photos/${c.id}/${p.sha256}.png`;
    if ((await upload(path, p.png)) === 'stored') stored++;
    else reused++;
    let att = (await rest<{ id: string }[]>('GET', `email_attachments?email_id=eq.${email.id}&sha256=eq.${p.sha256}&select=id`))[0];
    if (!att) {
      att = (await rest<{ id: string }[]>('POST', 'email_attachments?select=id', {
        email_id: email.id, filename: p.fileName, mime_type: 'image/png', size_bytes: p.png.length, storage_path: path, sha256: p.sha256, is_evidence: true,
      }, 'return=representation'))[0];
    }
    let ev = (await rest<{ id: string }[]>('GET', `evidence?case_id=eq.${c.id}&sha256=eq.${p.sha256}&select=id`))[0];
    if (!ev) {
      // Same columns as private.add_email_evidence() (insurer attachment → case evidence).
      ev = (await rest<{ id: string }[]>('POST', 'evidence?select=id', {
        case_id: c.id, evidence_type: 'photo', capture_source: 'email_attachment', storage_backend: 'supabase', storage_path: path,
        mime_type: 'image/png', size_bytes: p.png.length, sha256: p.sha256, original_filename: p.fileName, email_attachment_id: att.id,
        captured_by: null,
      }, 'return=representation'))[0];
      created++;
    }
    evidenceIds.push(ev.id);
  }

  // No pipeline runs locally: mark this script's queued jobs skipped (labels came from the file names).
  for (let i = 0; i < evidenceIds.length; i += 50) {
    const ids = evidenceIds.slice(i, i + 50).join(',');
    await rest('PATCH', `processing_jobs?evidence_id=in.(${ids})&status=eq.queued`, { status: 'skipped', finished_at: new Date().toISOString() }, 'return=minimal');
  }
  const labels = await rest<{ evidence_id: string; category: { code: string } | null }[]>(
    'GET', `evidence_labels?evidence_id=in.(${evidenceIds.join(',')})&is_active=eq.true&select=evidence_id,category:evidence_categories(code)`);
  const perCat = new Map<string, number>();
  for (const l of labels) perCat.set(l.category?.code ?? '?', (perCat.get(l.category?.code ?? '?') ?? 0) + 1);
  const unlabelled = evidenceIds.filter((id) => !labels.some((l) => l.evidence_id === id)).length;

  console.log(`${c.case_ref} (${c.insurers?.code ?? '?'}, ${c.status}): ${photos.length} photos — evidence ${created} new / ${photos.length - created} existing; storage ${stored} uploaded / ${reused} already there`);
  console.log(`labels: ${[...perCat].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}${unlabelled ? `; unlabelled ${unlabelled}` : ''}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
