import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/format";
import type { SearchParams } from "@/lib/list-params";
import {
  asNumberMap,
  asStringMap,
  buildReviewForm,
  REVIEW_REASONS,
  reviewReason,
  templateLabel,
} from "@/lib/intake-review";
import { Badge, Button, ErrorState, InlineAlert, PageHeader, Select, StatusBadge } from "@/components/ui";
import { fileHref } from "@/lib/evidence-view-core";
import { reparseForTemplate, type ReparseResult } from "@/lib/intake-reparse";
import { RejectDialog, ReviewForm } from "./review-form";

export const metadata = { title: "Intake review" };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function fileSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function IntakeReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await requireRole(STAFF_ROLES);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!GUID.test(id)) notFound();

  const supabase = await createClient();
  const [ext, templatesRes, insurersRes] = await Promise.all([
    supabase
      .from("intake_extractions")
      .select(
        "id, status, template_id, missing_required, parser_action, extracted, field_confidence, reject_reason, reviewed_at, emails!inner(id, subject, body_text, raw_storage_path, gmail_message_id, from_address, from_name, received_at, insurer_id, parse_notes, email_attachments(id, filename, mime_type, size_bytes, is_evidence, is_inline))",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase.from("case_templates").select("id, name, variant, version, insurer_id, claim_type, intake_rules").eq("is_active", true).order("name"),
    supabase.from("insurers").select("id, name, code").eq("is_active", true).order("name"),
  ]);

  if (ext.error || templatesRes.error || insurersRes.error) return <ErrorState what="This intake item" />;
  const x = ext.data;
  if (!x) notFound();
  const email = x.emails;
  const templates = templatesRes.data ?? [];
  const insurers = insurersRes.data ?? [];
  const reason = REVIEW_REASONS[reviewReason(x)];
  const pending = x.status === "pending_review";

  // Insurer and template: URL choice (override) > what the parser detected.
  const spInsurer = one(sp.insurer);
  const spTemplate = one(sp.template);
  const byId = new Map(templates.map((t) => [t.id, t]));
  const insurerId =
    (insurers.some((i) => i.id === spInsurer) ? spInsurer : null) ??
    (byId.get(spTemplate)?.insurer_id || byId.get(x.template_id ?? "")?.insurer_id || email.insurer_id || "");
  const candidate = byId.get(spTemplate) ?? byId.get(x.template_id ?? "");
  const template = candidate && (!insurerId || candidate.insurer_id === insurerId) ? candidate : null;
  const insurerTemplates = templates.filter((t) => !insurerId || t.insurer_id === insurerId);
  const detectedInactive = !!x.template_id && !byId.has(x.template_id);

  const fieldsRes = template
    ? await supabase
        .from("case_template_fields")
        .select("key, label, field_type, is_required, extract, options, help_text, position, case_template_sections(position, title)")
        .eq("template_id", template.id)
        .eq("source", "intake")
    : null;
  if (fieldsRes?.error) return <ErrorState what="The template fields" />;

  // Re-read the email for the chosen template when it is not the one the parser stored values for
  // (or nothing was stored). Read-only: the reviewer still confirms.
  let reparsed: ReparseResult | null = null;
  if (pending && template && fieldsRes?.data && (template.id !== x.template_id || Object.keys(asStringMap(x.extracted)).length === 0)) {
    let raw: Uint8Array | null = null;
    if (email.raw_storage_path) {
      const dl = await supabase.storage.from("email-raw").download(email.raw_storage_path);
      if (!dl.error && dl.data) raw = new Uint8Array(await dl.data.arrayBuffer());
    }
    const insurerCode = insurers.find((i) => i.id === template.insurer_id)?.code ?? "";
    try {
      reparsed = await reparseForTemplate(
        { subject: email.subject, from_address: email.from_address, received_at: email.received_at, body_text: email.body_text, message_id: email.gmail_message_id },
        raw,
        {
          id: template.id,
          insurer_id: template.insurer_id,
          insurer_code: insurerCode,
          claim_type: template.claim_type,
          variant: template.variant,
          version: template.version,
          intake_rules: template.intake_rules,
          fields: fieldsRes.data,
        },
      );
    } catch {
      reparsed = null;
    }
  }

  const form = template
    ? buildReviewForm(
        (fieldsRes?.data ?? []).map((f) => ({
          ...f,
          section_position: f.case_template_sections?.position ?? 0,
          section_title: f.case_template_sections?.title ?? null,
        })),
        reparsed ? reparsed.values : asStringMap(x.extracted),
        reparsed ? reparsed.confidence : asNumberMap(x.field_confidence),
        reparsed ? reparsed.missing : x.missing_required,
      )
    : null;

  const attachments = email.email_attachments ?? [];

  return (
    <>
      <PageHeader
        title={email.subject || "(no subject)"}
        breadcrumbs={[{ label: "Intake review", href: "/intake" }, { label: "Email" }]}
        badges={
          <>
            <StatusBadge kind="extraction_status" value={x.status} />
            {pending && <Badge tone={reason.tone}>{reason.label}</Badge>}
          </>
        }
        actions={pending ? <RejectDialog extractionId={x.id} /> : undefined}
      />

      {!pending && (
        <div className="mb-6">
          <InlineAlert title={x.status === "confirmed" ? "A case was created from this email" : "This email was dismissed"}>
            {x.reviewed_at && <>Reviewed {formatDateTime(x.reviewed_at)}. </>}
            {x.reject_reason && <>Reason: {x.reject_reason}</>}
          </InlineAlert>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section aria-labelledby="email-h" className="min-w-0 self-start rounded border border-border bg-surface p-4 sm:p-5">
          <h2 id="email-h" className="text-lg font-semibold">
            Email
          </h2>
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-text-muted">From</dt>
            <dd className="break-words">
              {email.from_name ? (
                <>
                  {email.from_name} <span className="text-text-muted">&lt;{email.from_address}&gt;</span>
                </>
              ) : (
                email.from_address
              )}
            </dd>
            <dt className="text-text-muted">Subject</dt>
            <dd className="break-words">{email.subject || "(no subject)"}</dd>
            <dt className="text-text-muted">Received</dt>
            <dd>{formatDateTime(email.received_at)}</dd>
          </dl>

          <h3 className="mt-5 text-sm font-semibold">Message</h3>
          {email.body_text?.trim() ? (
            <pre className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg p-3 font-sans text-sm">
              {email.body_text}
            </pre>
          ) : (
            <p className="mt-2 text-sm text-text-muted">No text in this email.</p>
          )}

          <h3 className="mt-5 text-sm font-semibold">Attachments ({attachments.length})</h3>
          {attachments.length ? (
            <ul className="mt-2 space-y-1 text-sm">
              {attachments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2">
                  <a
                    href={fileHref("attachment", a.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-primary underline hover:no-underline"
                  >
                    {a.filename}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <a href={fileHref("attachment", a.id, { download: true })} className="text-xs text-primary underline hover:no-underline">
                    Download<span className="sr-only"> {a.filename}</span>
                  </a>
                  <span className="text-xs text-text-muted">
                    {[a.mime_type, fileSize(a.size_bytes)].filter(Boolean).join(" · ")}
                  </span>
                  {a.is_evidence && <Badge tone="info">Evidence</Badge>}
                  {a.is_inline && <Badge>Inline</Badge>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-text-muted">None</p>
          )}

          {email.parse_notes.length > 0 && (
            <>
              <h3 className="mt-5 text-sm font-semibold">Parser notes</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-muted">
                {email.parse_notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="fields-h" className="min-w-0 rounded border border-border bg-surface p-4 sm:p-5">
          <h2 id="fields-h" className="text-lg font-semibold">
            Intake fields
          </h2>
          {pending && <p className="mt-1 text-sm text-text-muted">{reason.hint}</p>}

          {pending && (
            <form method="get" className="mt-4 flex flex-wrap items-end gap-3 border-b border-border pb-4">
              <div className="w-full sm:w-52">
                <label htmlFor="pick-insurer" className="mb-1 block text-xs font-medium text-text-muted">
                  Insurer
                </label>
                <Select
                  id="pick-insurer"
                  name="insurer"
                  defaultValue={insurerId}
                  placeholder="Choose…"
                  options={insurers.map((i) => ({ value: i.id, label: `${i.name} (${i.code})` }))}
                />
              </div>
              <div className="w-full sm:w-72">
                <label htmlFor="pick-template" className="mb-1 block text-xs font-medium text-text-muted">
                  Template
                </label>
                <Select
                  id="pick-template"
                  name="template"
                  defaultValue={template?.id ?? ""}
                  placeholder="Choose…"
                  options={insurerTemplates.map((t) => ({ value: t.id, label: templateLabel(t) }))}
                />
              </div>
              <Button type="submit" variant="secondary">
                Show fields
              </Button>
            </form>
          )}

          {pending && detectedInactive && (
            <div className="mt-4">
              <InlineAlert tone="warning">The detected template is no longer active. Choose an active one.</InlineAlert>
            </div>
          )}

          {pending && !template && (
            <div className="mt-4">
              <InlineAlert tone="warning" title="Choose a template">
                {insurerId && insurerTemplates.length === 0
                  ? "This insurer has no active template. An admin must load one before the case can be created."
                  : "Pick the insurer and template of this email, then Show fields."}
              </InlineAlert>
            </div>
          )}

          {pending && template && form && (
            <div className="mt-4">
              {reparsed && (
                <div className="mb-4">
                  <InlineAlert tone="info">
                    Values read again from the email for this template
                    {reparsed.source === "body" ? " (from the message text only)" : ""}. Check them before confirming.
                  </InlineAlert>
                </div>
              )}
              {form.issueCount > 0 && (
                <div className="mb-4">
                  <InlineAlert tone="warning">
                    {form.issueCount === 1 ? "1 field needs attention." : `${form.issueCount} fields need attention.`} Missing and
                    low-confidence values are highlighted below.
                  </InlineAlert>
                </div>
              )}
              {/* key: a different template gets a fresh form (new defaults, no stale errors) */}
              <ReviewForm key={template.id} extractionId={x.id} templateId={template.id} claim={form.claim} fields={form.fields} />
            </div>
          )}
        </section>
      </div>
    </>
  );
}
