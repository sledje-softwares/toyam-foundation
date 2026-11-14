import type { ItemState } from './types';

const NEXT: Record<ItemState, readonly ItemState[]> = {
  queued: ['uploading', 'held'],
  // back to queued on a transient error / restart; held on a refusal
  uploading: ['queued', 'stored', 'held'],
  stored: ['processed', 'seen'],
  processed: ['seen'],
  seen: [],
  // "Send now" or a new task from the office
  held: ['queued'],
};

export function canTransition(from: ItemState, to: ItemState): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: ItemState, to: ItemState): void {
  if (!canTransition(from, to)) throw new Error(`outbox: invalid transition ${from} → ${to}`);
}

/** Ticks only move forward: a late "processed" never downgrades "seen". */
export function tickRank(s: ItemState): number {
  return s === 'seen' ? 3 : s === 'processed' ? 2 : s === 'stored' ? 1 : 0;
}
