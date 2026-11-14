// Per-case composer draft (pure, in memory): the text, the category chip and the picked files waiting
// for Send. Shared by the composer and the camera screen, which sends its burst with the draft's
// caption and chip. Lost on app restart by design: nothing is "saved on the phone" until Send.
import type { PreparedFile } from './item';

export interface Draft {
  text: string;
  categoryCode: string | null;
  files: PreparedFile[];
}

const EMPTY: Draft = Object.freeze({ text: '', categoryCode: null, files: [] }) as Draft;

export class DraftStore {
  private drafts = new Map<string, Draft>();
  private listeners = new Set<() => void>();

  get(caseId: string): Draft {
    return this.drafts.get(caseId) ?? EMPTY;
  }

  update(caseId: string, patch: Partial<Draft>): void {
    this.drafts.set(caseId, { ...this.get(caseId), ...patch });
    this.emit();
  }

  addFiles(caseId: string, files: readonly PreparedFile[]): void {
    const d = this.get(caseId);
    const have = new Set(d.files.map((f) => f.sha256));
    const add = files.filter((f) => !have.has(f.sha256) && (have.add(f.sha256), true));
    this.update(caseId, { files: [...d.files, ...add] });
  }

  /** Returns the removed file so the caller can delete its sandbox copy. */
  removeFile(caseId: string, sha256: string): PreparedFile | null {
    const d = this.get(caseId);
    const f = d.files.find((x) => x.sha256 === sha256) ?? null;
    if (f) this.update(caseId, { files: d.files.filter((x) => x !== f) });
    return f;
  }

  /** After Send: text and files cleared, the chip kept for the next shot. */
  sent(caseId: string, keepFiles = false): void {
    const d = this.get(caseId);
    this.update(caseId, { text: '', files: keepFiles ? d.files : [] });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** App-wide instance. */
export const drafts = new DraftStore();
