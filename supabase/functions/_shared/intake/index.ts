// Intake decision for one email: pure function, used by supabase/functions/intake.
import { classify, findInsurer, isInternalSender, isReplyOrForward, matchTemplate, subjectVariant } from './detect.ts';
import { bodyText, extractFields, knownLabels } from './extract.ts';
import type { AttachmentDecision, EmailAttachment, IntakeConfig, IntakeDecision, ParsedEmail } from './types.ts';

export type * from './types.ts';
export { htmlRows, htmlToText, textRows } from './html.ts';

export const PARSER_VERSION = 'rules-v1';

const SKIP_FILES = /\.(ics|vcf|p7s|p7m)$|^winmail\.dat$/i;

/** Signature logos and tracking pixels are not evidence. */
export function isEvidenceAttachment(a: EmailAttachment, html: string | null | undefined): boolean {
  if (SKIP_FILES.test(a.filename)) return false;
  const cid = a.contentId?.replace(/[<>]/g, '');
  const referencedInline = !!cid && !!html && html.includes(`cid:${cid}`);
  if ((a.disposition === 'inline' || referencedInline) && a.mimeType.startsWith('image/') && a.size < 60_000) return false;
  return a.size > 0;
}

function attachmentDecisions(email: ParsedEmail, allowEvidence: boolean): AttachmentDecision[] {
  return email.attachments.map((a) => {
    const evidence = allowEvidence && isEvidenceAttachment(a, email.html);
    return {
      filename: a.filename || 'attachment',
      mime_type: a.mimeType || 'application/octet-stream',
      size_bytes: a.size,
      sha256: a.sha256 ?? null,
      storage_path: a.storagePath ?? null,
      content_id: a.contentId?.replace(/[<>]/g, '') ?? null,
      is_inline: a.disposition === 'inline',
      evidence,
    };
  });
}

export function processEmail(email: ParsedEmail, cfg: IntakeConfig, raw?: { path?: string; sha256?: string }): IntakeDecision {
  const text = bodyText(email);
  const notes: string[] = [];
  const base = {
    parser_version: PARSER_VERSION,
    message_id: email.messageId,
    thread_id: email.threadId ?? null,
    in_reply_to: email.inReplyTo ?? null,
    references: email.references,
    from_address: email.from.address.toLowerCase(),
    from_name: email.from.name ?? null,
    to: email.to.map((a) => a.address.toLowerCase()),
    cc: email.cc.map((a) => a.address.toLowerCase()),
    subject: email.subject,
    received_at: email.date,
    body_text: text.slice(0, 100_000),
    raw_storage_path: raw?.path ?? null,
    raw_sha256: raw?.sha256 ?? null,
  };

  if (isInternalSender(email, cfg)) {
    return {
      ...base, is_internal: true, insurer_id: null, template_id: null, classification: 'other',
      action: 'internal', claim_no: null, fields: {}, missing_required: [],
      attachments: attachmentDecisions(email, false), notes: ['Sent by the firm'],
    };
  }

  const insurer = findInsurer(email, cfg);
  if (!insurer) {
    return {
      ...base, is_internal: false, insurer_id: null, template_id: null, classification: 'other',
      action: 'unmatched', claim_no: null, fields: {}, missing_required: [],
      attachments: attachmentDecisions(email, false), notes: ['Sender domain does not belong to a known insurer'],
    };
  }

  const reply = isReplyOrForward(email.subject) || !!email.inReplyTo;
  const match = matchTemplate(email, insurer, cfg);
  const allowEvidence = match?.template.intake_rules.attachments_as_evidence !== false;
  const attachments = attachmentDecisions(email, allowEvidence);
  const evidenceCount = attachments.filter((a) => a.evidence).length;

  if (!match) {
    const v = subjectVariant(email, insurer, cfg);
    notes.push(v ? `No active template for ${insurer.code} variant "${v}"` : `No template of ${insurer.code} matches the subject`);
    return {
      ...base, is_internal: false, insurer_id: insurer.id, template_id: null,
      classification: classify(email, !reply, evidenceCount, text),
      action: reply ? 'attach_to_case' : 'review', claim_no: null, fields: {}, missing_required: [],
      attachments, notes,
    };
  }

  const { fields, missing, rowsSource } = extractFields(email, match.template, match.subjectValues, knownLabels(cfg, insurer.id));
  if (!match.viaPattern) notes.push('Template chosen without a subject pattern');
  if (rowsSource === 'text') notes.push('No HTML table: values read from plain text');
  const claimNo = fields.insurer_claim_no?.value ?? match.subjectValues.insurer_claim_no ?? null;
  if (!claimNo) missing.includes('insurer_claim_no') || missing.push('insurer_claim_no');

  let action: IntakeDecision['action'];
  if (reply) action = 'attach_to_case';
  else if (missing.length === 0 && match.viaPattern) action = 'create_case';
  else action = 'review';
  if (action === 'review' && missing.length > 0) notes.push(`Missing required: ${missing.join(', ')}`);

  return {
    ...base, is_internal: false, insurer_id: insurer.id, template_id: match.template.id,
    classification: classify(email, !reply, evidenceCount, text),
    action, claim_no: claimNo, fields, missing_required: missing, attachments, notes,
  };
}
