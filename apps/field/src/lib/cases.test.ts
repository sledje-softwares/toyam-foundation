import { describe, expect, it } from 'vitest';
import { splitCases, totalUnread, type CaseRow } from './cases.ts';

const row = (list: string, unread = 0): CaseRow => ({
  case_id: list + unread, case_ref: 'R', insurer_name: 'I', claim_type: 'motor_od', title: null,
  list, last_message_at: null, last_message_preview: null, unread_count: unread,
});

describe('cases', () => {
  it('splits by list, keeping order', () => {
    const { open, completed } = splitCases([row('open', 1), row('completed'), row('open', 2)]);
    expect(open.map((r) => r.unread_count)).toEqual([1, 2]);
    expect(completed).toHaveLength(1);
  });
  it('sums unread', () => expect(totalUnread([row('open', 2), row('open', 3)])).toBe(5));
});
