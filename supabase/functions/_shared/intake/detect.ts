// Sender, insurer, template and classification decisions.
import type { Classification, IntakeConfig, IntakeInsurer, IntakeTemplate, ParsedEmail } from './types.ts';

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase().trim() : '';
}

function domainMatches(domain: string, candidates: string[]): boolean {
  return candidates.some((c) => {
    const d = c.toLowerCase().trim();
    return d !== '' && (domain === d || domain.endsWith('.' + d));
  });
}

export function isInternalSender(email: ParsedEmail, cfg: IntakeConfig): boolean {
  const from = email.from.address.toLowerCase().trim();
  return cfg.internal_addresses.some((a) => a.toLowerCase().trim() === from)
    || domainMatches(domainOf(from), cfg.internal_domains);
}

export function findInsurer(email: ParsedEmail, cfg: IntakeConfig): IntakeInsurer | null {
  const d = domainOf(email.from.address);
  return cfg.insurers.find((i) => domainMatches(d, i.domains)) ?? null;
}

export function isReplyOrForward(subject: string): boolean {
  return /^\s*(re|fw|fwd)\s*:/i.test(subject);
}

export function stripReplyPrefixes(subject: string): string {
  return subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim();
}

export interface TemplateMatch {
  template: IntakeTemplate;
  subjectValues: Record<string, string>;
  viaPattern: boolean;
}

/**
 * The insurer's active template whose subject pattern matches. A captured `variant`
 * group must equal the template's variant (e.g. OD vs THEFT). If the insurer has exactly
 * one template and it has no subject pattern, that template is used.
 */
export function matchTemplate(email: ParsedEmail, insurer: IntakeInsurer, cfg: IntakeConfig): TemplateMatch | null {
  const templates = cfg.templates.filter((t) => t.insurer_id === insurer.id);
  for (const t of templates) {
    const p = t.intake_rules.subject_pattern;
    if (!p) continue;
    let re: RegExp;
    try {
      re = new RegExp(p, 'i');
    } catch {
      continue;
    }
    const m = re.exec(email.subject.trim());
    if (!m) continue;
    const values: Record<string, string> = {};
    for (const [key, group] of Object.entries(t.intake_rules.subject_groups ?? {})) {
      const v = m[group];
      if (v !== undefined && v.trim() !== '') values[key] = v.replace(/\s+/g, ' ').trim();
    }
    if (values.variant !== undefined && values.variant.toLowerCase() !== t.variant.toLowerCase()) continue;
    return { template: t, subjectValues: values, viaPattern: true };
  }
  if (templates.length === 1 && !templates[0].intake_rules.subject_pattern) {
    return { template: templates[0], subjectValues: {}, viaPattern: false };
  }
  return null;
}

/** Variant named in the subject even when no template exists for it (review note). */
export function subjectVariant(email: ParsedEmail, insurer: IntakeInsurer, cfg: IntakeConfig): string | null {
  for (const t of cfg.templates.filter((x) => x.insurer_id === insurer.id)) {
    const p = t.intake_rules.subject_pattern;
    const g = t.intake_rules.subject_groups?.variant;
    if (!p || !g) continue;
    try {
      const m = new RegExp(p, 'i').exec(email.subject.trim());
      if (m?.[g]) return m[g].toLowerCase();
    } catch { /* ignore bad pattern */ }
  }
  return null;
}

export function classify(email: ParsedEmail, isNewCase: boolean, evidenceCount: number, bodyText: string): Classification {
  if (isNewCase) return 'new_case';
  const hay = (email.subject + '\n' + bodyText.slice(0, 4000)).toLowerCase();
  if (/\breminder\b|\bgentle reminder\b|\bescalat|\bpending since\b|\boverdue\b|\btat\b/.test(hay)) return 'reminder';
  if (evidenceCount > 0) return 'additional_docs';
  if (hay.trim() !== '') return 'query';
  return 'other';
}
