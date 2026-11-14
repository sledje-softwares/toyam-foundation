// React binding (thin, untested): re-renders on every outbox change.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Outbox, OutboxSnapshot } from './outbox';
import { getOutbox } from './runtime';

const EMPTY: OutboxSnapshot = {
  items: [],
  online: false,
  mode: 'normal',
  paused: false,
  sending: null,
  last_success_at: null,
  last_prompt_at: null,
  next_retry_at: null,
};
const noop = () => () => {};

/** `{ outbox, snapshot }`; `outbox` is null until the store has loaded. Feed `snapshot` to the selectors. */
export function useOutbox(): { outbox: Outbox | null; snapshot: OutboxSnapshot } {
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  useEffect(() => {
    let live = true;
    void getOutbox().then((o) => {
      if (live) setOutbox(o);
    });
    return () => {
      live = false;
    };
  }, []);
  const snapshot = useSyncExternalStore(
    outbox ? (cb: () => void) => outbox.subscribe(cb) : noop,
    () => (outbox ? outbox.snapshot() : EMPTY),
  );
  return { outbox, snapshot };
}
