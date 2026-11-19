import { describe, expect, it } from 'vitest';
import type { OutboxFile, OutboxItem } from '../outbox';
import { caseListMenuItems } from './caseListMenu';

const file = (id: string): OutboxFile => ({
  id, local_path: `file:///x/${id}`, sha256: id, size_bytes: 1024, mime_type: 'image/jpeg', ext: 'jpg', evidence_type: 'photo',
  device_captured_at: '2026-11-14T10:00:00Z', gps: null, capture_source: 'camera', original_filename: null,
  checklist_item_id: null, storage_path: null, bytes_sent: 0,
});
const item = (id: string, files: OutboxFile[]): OutboxItem => ({
  client_message_id: id, case_id: 'c1', task_id: 't', kind: 'media', caption: null, category_code: null, reply_to: null, files,
  state: 'queued', created_at: '2026-11-14T10:00:00Z', attempts: 0, last_attempt_at: null, last_error: null, held_reason: null,
  message_id: null, stored_at: null, split_from: null,
});

describe('case list ⋮ menu', () => {
  it('Outbox first, then Sign out, also when nothing is waiting', () => {
    expect(caseListMenuItems([])).toEqual([
      { key: 'outbox', label: 'Outbox' },
      { key: 'sign_out', label: 'Sign out' },
    ]);
  });

  it('Outbox shows the count of files still on the phone', () => {
    expect(caseListMenuItems([item('a', [file('1'), file('2')])])[0]).toEqual({ key: 'outbox', label: 'Outbox (2)' });
  });
});
