// React binding (thin, untested): re-renders on every comment queue change.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CommentQueue, CommentSnapshot } from './queue';
import { getCommentQueue } from './runtime';

const EMPTY: CommentSnapshot = { comments: [], online: false, paused: false, next_retry_at: null };
const noop = () => () => {};

/** `{ queue, snapshot }`; `queue` is null until the store has loaded. */
export function useComments(): { queue: CommentQueue | null; snapshot: CommentSnapshot } {
  const [queue, setQueue] = useState<CommentQueue | null>(null);
  useEffect(() => {
    let live = true;
    void getCommentQueue().then((q) => { if (live) setQueue(q); }, () => {});
    return () => { live = false; };
  }, []);
  const snapshot = useSyncExternalStore(
    queue ? (cb: () => void) => queue.subscribe(cb) : noop,
    () => (queue ? queue.snapshot() : EMPTY),
  );
  return { queue, snapshot };
}
