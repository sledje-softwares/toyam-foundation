/** Pure helpers for the insurer form (/admin/insurers): normalisation and validation. Mirrors DB3 (code, TAT, domains). */

export const SUBMISSION_CHANNELS = ["email", "portal", "other"] as const;
export type SubmissionChannel = (typeof SUBMISSION_CHANNELS)[number];

export const PUBLIC_MAIL_DOMAINS = ["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "outlook.com", "hotmail.com", "live.com", "rediffmail.com", "icloud.com"];
export const MAX_DOMAINS = 20;
export const MAX_ALIAS_LABELS = 10;
export const MAX_ALIAS_LABEL_LENGTH = 60;
export const MAX_NOTES = 2000;

/** Fields M3 reads aliases for (key = extraction field name, label = shown to people). */
export const EXTRACTION_FIELDS = [
  { key: "insurer_claim_no", label: "Claim number" },
  { key: "policy_no", label: "Policy number" },
  { key: "claim_type", label: "Claim type" },
  { key: "claim_amount", label: "Claim amount" },
  { key: "incident_date", label: "Incident date" },
  { key: "insured_name", label: "Insured name" },
  { key: "patient_name", label: "Patient name" },
  { key: "hospital_name", label: "Hospital name" },
] as const;
const FIELD_KEYS: readonly string[] = EXTRACTION_FIELDS.map((f) => f.key);

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lower-case, trim; an email address (or `@domain`) is cut to its domain part. */
export function normaliseDomain(raw: string): { domain: string; keptDomainPart: boolean } {
  let s = raw.trim().toLowerCase();
  const at = s.lastIndexOf("@");
  const keptDomainPart = at >= 0;
  if (keptDomainPart) s = s.slice(at + 1);
  s = s.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "").trim();
  return { domain: s, keptDomainPart };
}

export function isValidDomain(d: string): boolean {
  return HOSTNAME.test(d);
}

export function isPublicMailDomain(d: string): boolean {
  return PUBLIC_MAIL_DOMAINS.includes(d);
}

/** Splits pasted text on commas, semicolons, spaces and newlines; normalises, de-duplicates against `existing`. */
export function addDomains(existing: string[], pasted: string): { domains: string[]; error: string | null; note: string | null } {
  const out = [...existing];
  let error: string | null = null;
  let note: string | null = null;
  for (const part of pasted.split(/[\s,;]+/).filter(Boolean)) {
    const { domain, keptDomainPart } = normaliseDomain(part);
    if (!isValidDomain(domain)) {
      error = `"${part}" is not a valid domain.`;
      continue;
    }
    if (isPublicMailDomain(domain)) {
      error = "Public email domains can't identify an insurer. Emails from these senders go to the review queue.";
      continue;
    }
    if (keptDomainPart) note = "We kept the domain part of the email address.";
    if (!out.includes(domain)) out.push(domain);
  }
  return { domains: out.sort(), error, note };
}

/** Rewrites the DB3 trigger message into the sentence shown in the form. */
export function domainConflictMessage(message: string): string | null {
  const m = /^Domain (\S+) is already used by (.+)$/.exec(message.trim());
  return m ? `${m[1]} is already used by ${m[2]}.` : null;
}

export type Alias = { field: string; labels: string[] };
export type InsurerFormValues = {
  name: string;
  code: string;
  sender_domains: string[];
  tat_days: string;
  submission_channel: string;
  reply_to_email: string;
  portal_url: string;
  notes: string;
  aliases: Alias[];
};
export type InsurerFieldErrors = Partial<Record<"name" | "code" | "sender_domains" | "tat_days" | "submission_channel" | "reply_to_email" | "portal_url" | "notes" | "aliases", string>>;

export function emptyInsurerValues(): InsurerFormValues {
  return { name: "", code: "", sender_domains: [], tat_days: "15", submission_channel: "email", reply_to_email: "", portal_url: "", notes: "", aliases: [] };
}

function parseJson(raw: FormDataEntryValue | null): unknown {
  try {
    return raw ? JSON.parse(String(raw)) : [];
  } catch {
    return [];
  }
}

export function readInsurerForm(fd: FormData): InsurerFormValues {
  const s = (k: string) => String(fd.get(k) ?? "");
  const domains = parseJson(fd.get("sender_domains"));
  const aliases = parseJson(fd.get("aliases"));
  return {
    name: s("name").trim(),
    code: s("code").trim().toUpperCase(),
    sender_domains: Array.isArray(domains) ? domains.filter((d): d is string => typeof d === "string") : [],
    tat_days: s("tat_days").trim(),
    submission_channel: s("submission_channel"),
    reply_to_email: s("reply_to_email").trim(),
    portal_url: s("portal_url").trim(),
    notes: s("notes").trim(),
    aliases: Array.isArray(aliases)
      ? aliases
          .filter((a): a is Alias => typeof a === "object" && a !== null && typeof (a as Alias).field === "string" && Array.isArray((a as Alias).labels))
          .map((a) => ({ field: a.field, labels: a.labels.filter((l): l is string => typeof l === "string").map((l) => l.trim()).filter(Boolean) }))
      : [],
  };
}

export function insurerErrors(v: InsurerFormValues): InsurerFieldErrors {
  const e: InsurerFieldErrors = {};
  if (v.name.length < 2 || v.name.length > 120) e.name = "Enter a name of 2 to 120 characters.";
  if (!/^[A-Z0-9]{2,10}$/.test(v.code)) e.code = "Use 2 to 10 capital letters or digits.";
  if (v.sender_domains.length > MAX_DOMAINS) e.sender_domains = `At most ${MAX_DOMAINS} domains.`;
  else {
    const bad = v.sender_domains.find((d) => !isValidDomain(d) || isPublicMailDomain(d));
    if (bad) e.sender_domains = isPublicMailDomain(bad) ? "Public email domains can't identify an insurer." : `"${bad}" is not a valid domain.`;
  }
  const tat = Number(v.tat_days);
  if (!/^\d+$/.test(v.tat_days) || tat < 1 || tat > 365) e.tat_days = "Enter a whole number of days from 1 to 365.";
  if (!(SUBMISSION_CHANNELS as readonly string[]).includes(v.submission_channel)) e.submission_channel = "Choose how reports are submitted.";
  if (v.reply_to_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.reply_to_email)) e.reply_to_email = "Enter a valid email address.";
  if (v.portal_url && !/^https:\/\/\S+$/i.test(v.portal_url)) e.portal_url = "The address must start with https://.";
  else if (v.submission_channel === "portal" && !v.portal_url) e.portal_url = "Enter the portal address.";
  if (v.notes.length > MAX_NOTES) e.notes = `At most ${MAX_NOTES} characters.`;
  const seen = new Set<string>();
  for (const a of v.aliases) {
    if (!FIELD_KEYS.includes(a.field)) e.aliases = "Choose a field for every row.";
    else if (seen.has(a.field)) e.aliases = "Each field can appear once.";
    else if (a.labels.length > MAX_ALIAS_LABELS || a.labels.some((l) => l.length > MAX_ALIAS_LABEL_LENGTH))
      e.aliases = `At most ${MAX_ALIAS_LABELS} labels per field, ${MAX_ALIAS_LABEL_LENGTH} characters each.`;
    seen.add(a.field);
  }
  return e;
}

export function hasInsurerErrors(e: InsurerFieldErrors): boolean {
  return Object.keys(e).length > 0;
}

/** Merges the form's notes and aliases into the stored hints; unknown keys (added by M3) are preserved. */
export function mergeHints(existing: unknown, notes: string, aliases: Alias[]): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  delete base.notes;
  delete base.aliases;
  const map: Record<string, string[]> = {};
  for (const a of aliases) if (a.labels.length) map[a.field] = [...new Set(a.labels)];
  return { ...base, ...(notes && { notes }), ...(Object.keys(map).length && { aliases: map }) };
}

/** Reads the form's notes and aliases back out of stored hints. */
export function readHints(hints: unknown): { notes: string; aliases: Alias[] } {
  const h = hints && typeof hints === "object" && !Array.isArray(hints) ? (hints as Record<string, unknown>) : {};
  const al = h.aliases && typeof h.aliases === "object" && !Array.isArray(h.aliases) ? (h.aliases as Record<string, unknown>) : {};
  return {
    notes: typeof h.notes === "string" ? h.notes : "",
    aliases: Object.entries(al)
      .filter(([, v]) => Array.isArray(v))
      .map(([field, v]) => ({ field, labels: (v as unknown[]).filter((x): x is string => typeof x === "string") })),
  };
}
