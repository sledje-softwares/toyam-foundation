// Shared types for the intake parser (Deno edge function + Node tests).
// The parser is pure: no I/O, no dependencies. MIME decoding happens in the caller.

export interface Address {
  address: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
  disposition?: 'inline' | 'attachment' | null;
  sha256?: string;        // filled by the caller (needs the bytes)
  storagePath?: string;   // filled by the caller after upload
}

/** A decoded email, independent of the MIME library used to produce it. */
export interface ParsedEmail {
  messageId: string;            // Message-ID header (without <>), or Gmail X-GM-MSGID fallback
  threadId?: string | null;     // Gmail X-GM-THRID when relayed over IMAP
  inReplyTo?: string | null;
  references: string[];
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  date: string;                 // ISO 8601
  text?: string | null;
  html?: string | null;
  attachments: EmailAttachment[];
}

export interface FieldExtract {
  labels?: string[];
  within?: string;
  regex?: string;
}

export interface IntakeField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  extract: FieldExtract;
}

export interface IntakeRules {
  sender_domains?: string[];
  subject_pattern?: string;
  subject_groups?: Record<string, number>;
  table_parser?: string;
  investigation_points?: { starts_after: string; until?: string };
  attachments_as_evidence?: boolean;
}

export interface IntakeTemplate {
  id: string;
  insurer_id: string;
  insurer_code: string;
  claim_type: string;
  variant: string;
  version: number;
  intake_rules: IntakeRules;
  fields: IntakeField[];        // intake-sourced fields only
}

export interface IntakeInsurer {
  id: string;
  code: string;
  name: string;
  domains: string[];
}

/** Returned by public.intake_config(); cached by the edge function. */
export interface IntakeConfig {
  internal_domains: string[];
  internal_addresses: string[];
  insurers: IntakeInsurer[];
  templates: IntakeTemplate[];
}

export type Classification = 'new_case' | 'reminder' | 'additional_docs' | 'query' | 'other';

/**
 * create_case    new case, all required intake fields found by rules
 * attach_to_case reply / follow-up; the database finds the case (thread or claim no.)
 * review         known insurer but no template match or required fields missing
 * internal       sent by the firm itself (never creates a case)
 * unmatched      unknown sender and no template match
 */
export type IntakeAction = 'create_case' | 'attach_to_case' | 'review' | 'internal' | 'unmatched';

export interface ExtractedValue {
  value: string;
  confidence: number;
  source: 'subject' | 'table' | 'text' | 'block' | 'regex';
}

export interface AttachmentDecision {
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string | null;
  storage_path: string | null;
  content_id: string | null;
  is_inline: boolean;
  evidence: boolean;            // store as case evidence (capture_source email_attachment)
}

/** Payload for public.intake_ingest(jsonb). Keys are snake_case to match SQL. */
export interface IntakeDecision {
  parser_version: string;
  message_id: string;
  thread_id: string | null;
  in_reply_to: string | null;
  references: string[];
  from_address: string;
  from_name: string | null;
  to: string[];
  cc: string[];
  subject: string;
  received_at: string;
  body_text: string;
  raw_storage_path: string | null;
  raw_sha256: string | null;
  is_internal: boolean;
  insurer_id: string | null;
  template_id: string | null;
  classification: Classification;
  action: IntakeAction;
  claim_no: string | null;
  fields: Record<string, ExtractedValue>;
  missing_required: string[];
  attachments: AttachmentDecision[];
  notes: string[];
}
