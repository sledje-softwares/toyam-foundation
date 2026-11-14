import type { ActionResult, LinkResult, PanelFile } from "@/lib/reports";
import { formatRelativeDay } from "@/lib/format";
import { Badge } from "@/components/ui";
import { LabelEditor, OpenFileButton, RelevanceButton } from "./evidence-actions";
import { PlannedButton, PlannedNote } from "./planned";

type Actions = {
  setRelevance: (fd: FormData) => Promise<ActionResult>;
  correctLabels: (fd: FormData) => Promise<ActionResult>;
  evidenceLink: (id: string) => Promise<LinkResult>;
};

const SOURCE_LABELS: Record<PanelFile["source"], string> = {
  camera: "Camera",
  gallery: "Gallery",
  share: "Shared",
  web_upload: "Office upload",
  email_attachment: "Insurer email",
};

const PROCESSING: Record<string, { label: string; tone: "info" | "danger" | "neutral" }> = {
  pending: { label: "Labelling…", tone: "info" },
  processing: { label: "Labelling…", tone: "info" },
  failed: { label: "Labelling failed", tone: "danger" },
  none: { label: "Not processed", tone: "neutral" },
};

function Tile({ f, caseRef, editable, labelOptions, actions }: { f: PanelFile; caseRef: string; editable: boolean; labelOptions: { id: string; name: string }[]; actions: Actions }) {
  const proc = f.labels.length === 0 && f.processing && f.processing !== "done" ? PROCESSING[f.processing] : null;
  return (
    <li className={`rounded border border-border bg-surface p-2 ${f.relevance === "not_relevant" ? "opacity-70" : ""}`}>
      <div className="flex gap-3">
        <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded bg-slate-100 text-xs uppercase text-text-muted">
          {f.thumbUrl ? (
            // Short-lived signed storage URL; next/image would need the storage host in remotePatterns.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={f.thumbUrl} alt={f.name} className="size-full object-cover" loading="lazy" />
          ) : (
            <span aria-hidden="true">{f.mime?.split("/")[1]?.slice(0, 4) ?? f.type}</span>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-medium" title={f.name}>
            {f.name}
          </p>
          <p className="text-xs text-text-muted">
            {SOURCE_LABELS[f.source]} · {formatRelativeDay(f.server_received_at)}
            {f.matchScore !== null && <> · match {Math.round(f.matchScore * 100)}%</>}
          </p>
          <p className="flex flex-wrap gap-1">
            {f.labels.map((l) => (
              <Badge key={l.categoryId} tone={l.source === "human" ? "success" : "info"}>
                {l.name}
                {l.confidence !== null && l.source !== "human" ? ` · ${Math.round(l.confidence * 100)}%` : ""}
              </Badge>
            ))}
            {proc && <Badge tone={proc.tone}>{proc.label}</Badge>}
            {f.relevance === "not_relevant" && <Badge>Not relevant</Badge>}
          </p>
          {f.description && <p className="line-clamp-2 text-xs text-text-muted">{f.description}</p>}
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3">
        <OpenFileButton evidenceId={f.id} canOpen={f.backend === "supabase"} link={actions.evidenceLink} />
        {editable && <RelevanceButton evidenceId={f.id} caseRef={caseRef} notRelevant={f.relevance === "not_relevant"} action={actions.setRelevance} />}
        <span className="text-xs text-text-muted" title="Planned (7.3): OCR text with tap-to-fill into the focused field">
          OCR text <span className="rounded bg-slate-100 px-1 py-0.5">Planned · 7.3</span>
        </span>
      </div>
      {editable && <LabelEditor evidenceId={f.id} caseRef={caseRef} current={f.categoryIds} options={labelOptions} action={actions.correctLabels} />}
    </li>
  );
}

function Group({ title, files, ...rest }: { title: string; files: PanelFile[]; caseRef: string; editable: boolean; labelOptions: { id: string; name: string }[]; actions: Actions }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
        {title} ({files.length})
      </h3>
      <ul className="space-y-2">
        {files.map((f) => (
          <Tile key={f.id} f={f} {...rest} />
        ))}
      </ul>
    </section>
  );
}

/** 7.2: files whose active label is in the focused section's categories (or match its fields), plus unlabelled. */
export function EvidencePanel({
  sectionTitle,
  categories,
  panel,
  caseRef,
  editable,
  labelOptions,
  actions,
}: {
  sectionTitle: string | null;
  categories: { id: string; name: string }[];
  panel: { matched: PanelFile[]; unlabelled: PanelFile[]; notRelevant: PanelFile[] };
  caseRef: string;
  editable: boolean;
  labelOptions: { id: string; name: string }[];
  actions: Actions;
}) {
  const shared = { caseRef, editable, labelOptions, actions };
  const empty = panel.matched.length + panel.unlabelled.length + panel.notRelevant.length === 0;
  return (
    <div className="space-y-4 rounded border border-border bg-surface p-4">
      <div>
        <h2 id="files-h" className="text-base font-semibold">
          Files{sectionTitle ? ` for “${sectionTitle}”` : ""}
        </h2>
        <p className="mt-1 text-xs text-text-muted">
          {categories.length ? <>Categories: {categories.map((c) => c.name).join(", ")}</> : "This section has no evidence categories; only unlabelled files are shown."}
        </p>
      </div>
      <PlannedButton piece="7.6">Choose annexures</PlannedButton>
      {empty ? (
        <p className="rounded border border-dashed border-border-input px-3 py-6 text-center text-sm text-text-muted">
          No files for this section yet. Field files and insurer attachments appear here once they are labelled.
        </p>
      ) : (
        <>
          {panel.matched.length > 0 && <Group title="For this section" files={panel.matched} {...shared} />}
          {panel.unlabelled.length > 0 && <Group title="Unlabelled" files={panel.unlabelled} {...shared} />}
          {panel.notRelevant.length > 0 && (
            <details>
              <summary className="min-h-8 cursor-pointer text-xs font-semibold uppercase tracking-wide text-text-muted">
                Not relevant ({panel.notRelevant.length})
              </summary>
              <div className="mt-2">
                <Group title="Marked not relevant" files={panel.notRelevant} {...shared} />
              </div>
            </details>
          )}
        </>
      )}
      <PlannedNote piece="7.3" title="OCR viewer and tap-to-fill">
        Tap a file to read its text with the blocks highlighted, then tap a block to copy it into the focused field.
      </PlannedNote>
    </div>
  );
}
