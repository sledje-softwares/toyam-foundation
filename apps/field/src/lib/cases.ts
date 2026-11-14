export type CaseRow = {
  case_id: string;
  case_ref: string;
  insurer_name: string;
  claim_type: string;
  title: string | null;
  list: 'open' | 'completed' | string;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
};

export type CaseTab = 'open' | 'completed';

/** Split the `field_case_list()` rows into the two tabs (the server decides `list`; anything else is Completed). */
export function splitCases(rows: CaseRow[]): Record<CaseTab, CaseRow[]> {
  const open: CaseRow[] = [];
  const completed: CaseRow[] = [];
  for (const r of rows) (r.list === 'open' ? open : completed).push(r);
  return { open, completed };
}

export function totalUnread(rows: CaseRow[]): number {
  return rows.reduce((n, r) => n + (r.unread_count > 0 ? r.unread_count : 0), 0);
}
