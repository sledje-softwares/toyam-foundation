import type { Enums } from "@/lib/database.types";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700",
  info: "bg-primary-soft text-blue-900",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

/** Colour never carries meaning alone: the label is always shown. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

type Entry = { label: string; tone: Tone };

export const STATUS_MAPS = {
  case_status: {
    received: { label: "Received", tone: "neutral" },
    intake_confirmed: { label: "Intake confirmed", tone: "info" },
    assigned: { label: "Assigned", tone: "info" },
    field_in_progress: { label: "In the field", tone: "info" },
    office_review: { label: "Office review", tone: "warning" },
    orchestrator_review: { label: "Awaiting approval", tone: "warning" },
    submitted: { label: "Submitted", tone: "success" },
    closed: { label: "Closed", tone: "neutral" },
    cancelled: { label: "Cancelled", tone: "danger" },
  },
  task_status: {
    pending: { label: "Pending", tone: "neutral" },
    in_progress: { label: "In progress", tone: "info" },
    completed: { label: "Completed", tone: "success" },
    cancelled: { label: "Cancelled", tone: "danger" },
  },
  checklist_status: {
    pending: { label: "Missing", tone: "warning" },
    captured: { label: "Captured", tone: "success" },
    not_available: { label: "Not available", tone: "neutral" },
    waived: { label: "Waived", tone: "neutral" },
  },
  extraction_status: {
    pending_review: { label: "Needs review", tone: "warning" },
    confirmed: { label: "Confirmed", tone: "success" },
    rejected: { label: "Rejected", tone: "danger" },
  },
  email_status: {
    pending: { label: "Waiting", tone: "neutral" },
    processing: { label: "Processing", tone: "info" },
    processed: { label: "Processed", tone: "success" },
    failed: { label: "Failed", tone: "danger" },
    ignored: { label: "Ignored", tone: "neutral" },
  },
  report_status: {
    draft: { label: "Draft", tone: "warning" },
    final: { label: "Final", tone: "success" },
  },
  active: {
    active: { label: "Active", tone: "success" },
    inactive: { label: "Inactive", tone: "neutral" },
  },
  in_use: {
    in_use: { label: "In use", tone: "success" },
    not_in_use: { label: "Not in use", tone: "neutral" },
  },
} as const satisfies {
  case_status: Record<Enums<"case_status">, Entry>;
  task_status: Record<Enums<"task_status">, Entry>;
  checklist_status: Record<Enums<"checklist_status">, Entry>;
  extraction_status: Record<Enums<"extraction_status">, Entry>;
  email_status: Record<Enums<"email_status">, Entry>;
  report_status: Record<Enums<"report_status">, Entry>;
  active: Record<"active" | "inactive", Entry>;
  in_use: Record<"in_use" | "not_in_use", Entry>;
};

export type StatusKind = keyof typeof STATUS_MAPS;

/** <StatusBadge kind="case_status" value={row.status} /> */
export function StatusBadge({ kind, value }: { kind: StatusKind; value: string | null | undefined }) {
  const map = STATUS_MAPS[kind] as Record<string, Entry>;
  const entry = value ? map[value] : undefined;
  if (!entry) return <Badge>{value ?? "—"}</Badge>;
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}
