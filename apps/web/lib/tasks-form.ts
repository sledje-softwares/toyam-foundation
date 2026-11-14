/**
 * Assign field task / re-investigation form (4.3, 4.4): read and validate the submitted values.
 * Pure; the server action re-reads the allowed operators, checklists and parent tasks before calling create_field_task().
 */
import { isGuid } from "./tasks";

export type TaskMode = "task" | "reinvestigation";

export function parseMode(raw: string | string[] | undefined | null): TaskMode {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return v === "reinvestigation" ? "reinvestigation" : "task";
}

export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
/** Instructions become a thread message for a re-investigation (case_messages.body <= 4000). */
export const INSTRUCTIONS_MAX = 4000;
export const REQUEST_MIN = 10;
export const LOCATION_MAX = 300;
const MAX_DUE_DAYS = 366;

export type TaskFormValues = {
  mode: TaskMode;
  case_id: string;
  assignee_id: string;
  kind: string;
  parent_task_id: string;
  title: string;
  instructions: string;
  checklist_id: string;
  due_at: string;
  location: string;
};

export type TaskFieldErrors = Partial<Record<keyof TaskFormValues, string>>;

export function emptyTaskForm(mode: TaskMode): TaskFormValues {
  return { mode, case_id: "", assignee_id: "", kind: "", parent_task_id: "", title: "", instructions: "", checklist_id: "", due_at: "", location: "" };
}

export function readTaskForm(fd: FormData): TaskFormValues {
  const s = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  return {
    mode: parseMode(s("mode")),
    case_id: s("case_id"),
    assignee_id: s("assignee_id"),
    kind: s("kind"),
    parent_task_id: s("parent_task_id"),
    title: s("title"),
    instructions: s("instructions"),
    checklist_id: s("checklist_id"),
    due_at: s("due_at"),
    location: s("location"),
  };
}

const LOCAL_DT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Reads a `datetime-local` value as India time (+05:30). Null when malformed or not a real date. */
export function parseIstDateTime(raw: string): Date | null {
  const m = LOCAL_DT.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "00"].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s) - 5.5 * 3_600_000;
  const date = new Date(utc);
  // Round trip rejects 31 Feb and the like.
  const back = new Date(utc + 5.5 * 3_600_000);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return date;
}

/** `datetime-local` value (IST) for a date, e.g. to pre-fill the field. */
export function toIstInput(d: Date): string {
  const t = new Date(d.getTime() + 5.5 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

export type TaskFormContext = {
  now: Date;
  /** Active field operators offered on the form. */
  operatorIds: ReadonlySet<string>;
  /** Checklists offered for this case. */
  checklistIds: ReadonlySet<string>;
  /** Tasks of this case (possible parents). */
  parentIds: ReadonlySet<string>;
};

export type CreateTaskInput = {
  p_case_id: string;
  p_assignee_id: string;
  p_title: string;
  p_kind: "initial" | "other" | "re_investigation";
  p_instructions?: string;
  p_checklist_template_id?: string;
  p_due_at?: string;
  p_location_text?: string;
  p_parent_task_id?: string;
};

/** Field errors, and the create_field_task() arguments when there are none. */
export function validateTaskForm(v: TaskFormValues, ctx: TaskFormContext): { errors: TaskFieldErrors; input: CreateTaskInput | null } {
  const e: TaskFieldErrors = {};
  const reinv = v.mode === "reinvestigation";

  if (!isGuid(v.case_id)) e.case_id = "Reload the page and try again.";
  if (!v.assignee_id) e.assignee_id = "Choose a field operator.";
  else if (!isGuid(v.assignee_id) || !ctx.operatorIds.has(v.assignee_id)) e.assignee_id = "Choose one of the listed operators.";

  const kind: CreateTaskInput["p_kind"] | null = reinv ? "re_investigation" : v.kind === "initial" || v.kind === "other" ? v.kind : null;
  if (!kind) e.kind = "Choose the kind of field work.";

  if (v.title.length < TITLE_MIN || v.title.length > TITLE_MAX) e.title = `Enter a title of ${TITLE_MIN} to ${TITLE_MAX} characters.`;

  if (reinv && v.instructions.length < REQUEST_MIN) e.instructions = `Describe what is needed (at least ${REQUEST_MIN} characters).`;
  else if (v.instructions.length > INSTRUCTIONS_MAX) e.instructions = `Use at most ${INSTRUCTIONS_MAX} characters.`;

  if (v.checklist_id && (!isGuid(v.checklist_id) || !ctx.checklistIds.has(v.checklist_id))) e.checklist_id = "Choose one of the listed checklists.";
  if (v.parent_task_id && (!isGuid(v.parent_task_id) || !ctx.parentIds.has(v.parent_task_id))) e.parent_task_id = "Choose a task of this case.";

  let due: Date | null = null;
  if (v.due_at) {
    due = parseIstDateTime(v.due_at);
    if (!due) e.due_at = "Enter a valid date and time.";
    else if (due.getTime() <= ctx.now.getTime()) e.due_at = "The due time must be in the future.";
    else if (due.getTime() > ctx.now.getTime() + MAX_DUE_DAYS * 86_400_000) e.due_at = "The due date must be within a year.";
  }

  if (v.location.length > LOCATION_MAX) e.location = `Use at most ${LOCATION_MAX} characters.`;

  if (Object.keys(e).length > 0 || !kind) return { errors: e, input: null };
  return {
    errors: e,
    input: {
      p_case_id: v.case_id,
      p_assignee_id: v.assignee_id,
      p_title: v.title,
      p_kind: kind,
      ...(v.instructions && { p_instructions: v.instructions }),
      ...(v.checklist_id && { p_checklist_template_id: v.checklist_id }),
      ...(due && { p_due_at: due.toISOString() }),
      ...(v.location && { p_location_text: v.location }),
      ...(v.parent_task_id && { p_parent_task_id: v.parent_task_id }),
    },
  };
}
