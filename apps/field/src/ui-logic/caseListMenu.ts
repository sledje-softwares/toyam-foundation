// Pure entries of the case list's header menu (⋮ on "My cases"). Same style as the thread's ⋮ menu.
// "Outbox" is always there (also when nothing is waiting: "Everything is sent ✓"); "Sign out" runs the
// unchanged D43 sign-out check (canSignOut: files still on the phone → dialog first).
import type { OutboxItem } from '../outbox/types';
import { outboxMenuLabel } from './offline';

export type CaseListMenuKey = 'outbox' | 'sign_out';

export interface CaseListMenuItem {
  key: CaseListMenuKey;
  label: string;
}

export const SIGN_OUT_LABEL = 'Sign out';

export function caseListMenuItems(items: readonly OutboxItem[]): CaseListMenuItem[] {
  return [
    { key: 'outbox', label: outboxMenuLabel(items) ?? 'Outbox' },
    { key: 'sign_out', label: SIGN_OUT_LABEL },
  ];
}
