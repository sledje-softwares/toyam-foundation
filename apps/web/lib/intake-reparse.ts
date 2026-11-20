/**
 * Intake review: read the email again for the template the reviewer chose (read-only, nothing is stored).
 * Reuses the shared deterministic parser (supabase/functions/_shared/intake), the same code the intake
 * function runs. The ParsedEmail comes from the raw .eml when it could be read, else from the stored
 * body text only (plain-text row path).
 */
import PostalMime from "postal-mime";
import { fromPostalMime } from "@shared/intake/mime.ts";
import { extractFields, knownLabels } from "@shared/intake/extract.ts";
import { matchTemplate } from "@shared/intake/detect.ts";
import type { IntakeConfig, IntakeTemplate, ParsedEmail } from "@shared/intake/types.ts";

export type ReparseResult = {
  values: Record<string, string>;
  confidence: Record<string, number>;
  missing: string[];
  /** Where the email came from: the raw message (HTML table) or the stored body text only. */
  source: "raw" | "body";
};

export type ReparseTemplate = {
  id: string;
  insurer_id: string;
  insurer_code: string;
  claim_type: string;
  variant: string;
  version: number;
  intake_rules: unknown;
  fields: { key: string; label: string; field_type: string; is_required: boolean; extract: unknown }[];
};

type EmailRow = { subject: string | null; from_address: string; received_at: string; body_text: string | null; message_id?: string | null };

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function toIntakeTemplate(t: ReparseTemplate): IntakeTemplate {
  return {
    id: t.id,
    insurer_id: t.insurer_id,
    insurer_code: t.insurer_code,
    claim_type: t.claim_type,
    variant: t.variant,
    version: t.version,
    intake_rules: asRecord(t.intake_rules),
    fields: t.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.field_type,
      required: f.is_required,
      extract: asRecord(f.extract),
    })),
  };
}

/** Decodes a raw .eml; null when it cannot be decoded (caller falls back to the body text). */
export async function parseRaw(raw: Uint8Array, row: EmailRow): Promise<ParsedEmail | null> {
  try {
    const pm = await PostalMime.parse(raw);
    // The stored Message-ID is only a fallback so a header-less mail still decodes.
    return await fromPostalMime(pm, { gmailMessageId: row.message_id ?? "review" });
  } catch {
    return null;
  }
}

export function bodyOnlyEmail(row: EmailRow): ParsedEmail {
  return {
    messageId: row.message_id ?? "review",
    references: [],
    from: { address: row.from_address },
    to: [],
    cc: [],
    subject: row.subject ?? "",
    date: row.received_at,
    text: row.body_text ?? "",
    html: null,
    attachments: [],
  };
}

export async function reparseForTemplate(row: EmailRow, raw: Uint8Array | null, template: ReparseTemplate): Promise<ReparseResult> {
  const t = toIntakeTemplate(template);
  const parsedRaw = raw ? await parseRaw(raw, row) : null;
  const email = parsedRaw ?? bodyOnlyEmail(row);
  const cfg: IntakeConfig = {
    internal_domains: [],
    internal_addresses: [],
    insurers: [{ id: t.insurer_id, code: t.insurer_code, name: t.insurer_code, domains: [] }],
    templates: [t],
  };
  // Subject values (claim no. etc.) only when the subject pattern fits this template; otherwise body only.
  const match = matchTemplate(email, cfg.insurers[0], cfg);
  const res = extractFields(email, t, match?.subjectValues ?? {}, knownLabels(cfg, t.insurer_id));
  const values: Record<string, string> = {};
  const confidence: Record<string, number> = {};
  for (const [k, v] of Object.entries(res.fields)) {
    values[k] = v.value;
    confidence[k] = v.confidence;
  }
  return { values, confidence, missing: res.missing, source: parsedRaw ? "raw" : "body" };
}
