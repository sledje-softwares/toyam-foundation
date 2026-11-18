import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/format";
import { applyListParams, parseListParams, type ListConfig, type SearchParams } from "@/lib/list-params";
import { CAPTURE_SOURCE_LABELS, caseHref, fileSize, parseEvidenceSource, PROCESSING_LABELS } from "@/lib/cases";
import { Badge, DataTable, EmptyState, ErrorState, FilterBar, Pagination, type Column } from "@/components/ui";
import { fileHref } from "@/lib/evidence-view-core";
import { toCachedFile } from "@/lib/file-cache/view-core";
import { CachedImage, PreviewButton } from "@/components/evidence/cached-image";
import { loadCase, refParam } from "../load";

const LIST: ListConfig = {
  pageSize: 100,
  sortable: ["server_received_at"],
  defaultSort: { key: "server_received_at", dir: "desc" },
};

const SELECT =
  "id, case_id, sha256, original_filename, evidence_type, mime_type, size_bytes, capture_source, server_received_at, is_flagged, flag_reason, relevance, withdrawn_at, captured:profiles!evidence_captured_by_fkey(full_name), task:tasks!evidence_task_id_fkey(title), message:case_messages!evidence_message_id_fkey(visibility), labels:evidence_labels!evidence_labels_evidence_id_fkey(id, is_active, source, confidence, description, needs_detail, category:evidence_categories!evidence_labels_category_id_fkey(name)), evidence_derivatives(width, sha256, size_bytes, pixel_width)";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export default async function CaseEvidencePage({
  params,
  searchParams,
}: {
  params: Promise<{ ref: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await requireRole(STAFF_ROLES);
  const [p, sp] = await Promise.all([params, searchParams]);
  const ref = refParam(p.ref);
  const c = ref ? await loadCase(ref) : null;
  if (!c || c === "error") notFound();
  const base = caseHref(c.case_ref, "evidence");

  const list = parseListParams(sp, LIST);
  const source = parseEvidenceSource(sp.source);
  const flagged = sp.flagged === "1";

  const supabase = await createClient();
  let query = supabase.from("evidence").select(SELECT, { count: "exact" }).eq("case_id", c.id);
  if (source === "email") query = query.eq("capture_source", "email_attachment");
  if (source === "field") query = query.neq("capture_source", "email_attachment");
  if (flagged) query = query.eq("is_flagged", true);
  query = applyListParams(query, list, LIST);

  const [{ data, count, error }, processing] = await Promise.all([
    query,
    supabase.from("v_evidence_processing").select("evidence_id, state").eq("case_id", c.id),
  ]);
  const state = new Map((processing.data ?? []).map((r) => [r.evidence_id, r.state]));

  const rows = data ?? [];
  type Row = (typeof rows)[number];

  // Thumbnails (384 px copy, else an inline-safe original) and previews (1600 px copy) load in the browser through the
  // hash-checked file cache: the hashes of every variant come from this RLS read, so a cached file needs no request.

  const columns: Column<Row>[] = [
    {
      key: "file",
      header: "File",
      cell: (r) => {
        const name = r.original_filename || `${r.evidence_type} file`;
        const file = toCachedFile(r);
        const placeholder = (
          <span aria-hidden="true" className="text-[10px] uppercase text-text-muted">
            {r.mime_type?.split("/")[1]?.slice(0, 4) ?? r.evidence_type}
          </span>
        );
        return (
          <span className="flex max-w-80 items-start gap-2">
            {r.evidence_type !== "note" && (
              <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded bg-slate-100">
                {file ? <CachedImage file={file} purpose="thumb" alt={name} placeholder={placeholder} /> : placeholder}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate" title={r.original_filename ?? undefined}>
                {name}
              </span>
              <span className="block text-xs text-text-muted">{[r.mime_type, fileSize(r.size_bytes)].filter(Boolean).join(" · ")}</span>
              {r.evidence_type !== "note" && (
                <span className="flex flex-wrap gap-x-3 text-xs">
                  {file && <PreviewButton file={file} name={name} />}
                  <a href={fileHref("evidence", r.id)} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:no-underline">
                    Open<span className="sr-only"> {name} in a new tab</span>
                  </a>
                  <a href={fileHref("evidence", r.id, { download: true })} className="text-primary underline hover:no-underline">
                    Download<span className="sr-only"> {name}</span>
                  </a>
                </span>
              )}
            </span>
          </span>
        );
      },
    },
    {
      key: "source",
      header: "Source",
      cell: (r) => (
        <span className="block">
          {CAPTURE_SOURCE_LABELS[r.capture_source]}
          <span className="block text-xs text-text-muted">{one(r.captured)?.full_name ?? (r.capture_source === "email_attachment" ? "Insurer" : "—")}</span>
        </span>
      ),
    },
    { key: "server_received_at", header: "Received", sortable: true, width: "w-40", cell: (r) => formatDateTime(r.server_received_at) },
    {
      key: "labels",
      header: "Labels",
      cell: (r) => {
        const active = (r.labels ?? []).filter((l) => l.is_active);
        if (!active.length) return <span className="text-text-muted">Not labelled</span>;
        return (
          <span className="flex max-w-80 flex-wrap gap-1">
            {active.map((l) => (
              <span key={l.id} title={l.description ?? undefined}>
                <Badge tone={l.source === "human" || l.source === "operator" ? "success" : "info"}>
                  {one(l.category)?.name ?? "Category"}
                  {l.confidence !== null && l.source !== "human" && l.source !== "operator" ? ` ${Math.round(l.confidence * 100)}%` : ""}
                </Badge>
              </span>
            ))}
            {active.some((l) => l.needs_detail) && <Badge tone="warning">Needs detail</Badge>}
          </span>
        );
      },
    },
    {
      key: "processing",
      header: "Processing",
      cell: (r) => {
        const s = PROCESSING_LABELS[state.get(r.id) ?? "none"] ?? PROCESSING_LABELS.none;
        return <Badge tone={s.tone}>{s.label}</Badge>;
      },
    },
    {
      key: "flags",
      header: "Flags",
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.withdrawn_at && <Badge>Withdrawn</Badge>}
          {r.is_flagged && (
            <span title={r.flag_reason ?? undefined}>
              <Badge tone="danger">Flagged</Badge>
            </span>
          )}
          {r.relevance === "not_relevant" && <Badge>Not relevant</Badge>}
          {r.relevance === "relevant" && <Badge tone="success">Relevant</Badge>}
          {one(r.message)?.visibility === "staff" && <Badge tone="warning">Staff only</Badge>}
          {one(r.task) && <span className="text-xs text-text-muted">{one(r.task)?.title}</span>}
        </span>
      ),
    },
  ];

  return (
    <>
      <Suspense>
        <FilterBar
          noSearch
          total={count ?? 0}
          filters={[
            {
              name: "source",
              label: "From",
              options: [
                { value: "field", label: "Field and office uploads" },
                { value: "email", label: "Insurer email" },
              ],
            },
            { name: "flagged", label: "Flagged", allLabel: "Any", options: [{ value: "1", label: "Flagged only" }] },
          ]}
        />
      </Suspense>
      {error ? (
        <ErrorState what="The evidence list" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            basePath={base}
            searchParams={sp}
            list={list}
            caption={`Files of case ${c.case_ref}`}
            empty={
              <EmptyState
                filtered={Boolean(source || flagged)}
                title="No files yet"
                description="Insurer attachments and files from the field app appear here."
              />
            }
          />
          <Pagination page={list.page} pageSize={list.pageSize} total={count ?? 0} basePath={base} searchParams={sp} />
        </>
      )}
    </>
  );
}
