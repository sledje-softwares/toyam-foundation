import { describe, expect, it } from 'vitest';
import type { CommentSnapshot } from '../comments/queue';
import type { PendingComment } from '../comments/types';
import { attachInfo, commentsByEvidence, labelsByEvidence, serverCommentIds } from '../thread/info';
import { mergeThread, type ServerFile, type ThreadFile } from '../thread/model';
import {
  COMMENT_STATUS, commentBadge, commentSignOutView, commentStatus, fileInfoView, labelChips, labelDescription, newlySentComments,
  NOT_SENT_COMMENT_TEXT,
} from './fileInfo';

const NOW = new Date('2026-11-27T12:00:00Z');
const ME = 'u-me';

const sfile = (id: string, over: Partial<ServerFile> = {}): ServerFile => ({
  id, message_id: 'm1', evidence_type: 'photo', mime_type: 'image/jpeg', size_bytes: 1, original_filename: `${id}.jpg`, sha256: `sha-${id}`,
  copies: [], processing: 'done', ...over,
});
const tf = (over: Partial<ThreadFile> = {}): ThreadFile => ({
  key: 'k', sha256: 'k', evidenceId: 'e1', kind: 'image', name: 'a.jpg', sizeBytes: 1, mime: 'image/jpeg', local: null, copies: [],
  state: null, progress: null, labels: [], comments: [], processing: 'done', ...over,
});
const pending = (id: string, over: Partial<PendingComment> = {}): PendingComment => ({
  client_comment_id: id, case_id: 'c1', evidence_id: 'e1', body: `body ${id}`, created_at: '2026-11-27T11:58:00Z', state: 'queued',
  attempts: 0, last_attempt_at: null, last_error: null, held_reason: null, comment_id: null, sent_at: null, ...over,
});
const snap = (comments: PendingComment[] = [], over: Partial<CommentSnapshot> = {}): CommentSnapshot => ({
  comments, online: true, paused: false, next_retry_at: null, ...over,
});

describe('info mapping (thread/info)', () => {
  it('labels: active only, category embedded as object or array, no confidence or model fields', () => {
    const m = labelsByEvidence([
      {
        id: 'e1',
        labels: [
          { is_active: true, source: 'llm', description: '  Front view of the car at the garage ', category: { code: 'vehicle', name: 'Vehicle photo' } },
          { is_active: false, source: 'model', description: 'old', category: { code: 'spot', name: 'Spot photo' } },
          { is_active: true, source: 'operator', description: null, category: [{ code: 'spot', name: 'Spot photo' }] },
          { is_active: true, source: 'llm', description: null, category: null },
        ],
      },
      { id: 'e2', labels: null },
    ]);
    expect(m.get('e1')).toEqual([
      { code: 'vehicle', name: 'Vehicle photo', source: 'llm', description: 'Front view of the car at the garage' },
      { code: 'spot', name: 'Spot photo', source: 'operator', description: null },
    ]);
    expect(m.get('e2')).toEqual([]);
  });

  it('comments per file, oldest first, blank ones dropped', () => {
    const m = commentsByEvidence([
      { id: 'b', evidence_id: 'e1', body: 'second', author_id: 'o', created_at: '2026-11-27T11:00:00Z', client_comment_id: null },
      { id: 'a', evidence_id: 'e1', body: ' first ', author_id: ME, created_at: '2026-11-27T10:00:00+00:00', client_comment_id: 'cc-1' },
      { id: 'c', evidence_id: 'e2', body: '  ', author_id: ME, created_at: '2026-11-27T10:00:00Z', client_comment_id: null },
    ]);
    expect(m.get('e1')!.map((c) => [c.id, c.body])).toEqual([['a', 'first'], ['b', 'second']]);
    expect(m.has('e2')).toBe(false);
  });

  it('attachInfo: a failed read keeps what the previous fetch had; serverCommentIds', () => {
    const prev = [sfile('e1', { labels: [{ code: 'x', name: 'X', source: 'llm', description: null }], comments: [] })];
    const out = attachInfo([sfile('e1'), sfile('e2')], null, [
      { id: 'a', evidence_id: 'e2', body: 'hi', author_id: ME, created_at: '2026-11-27T10:00:00Z', client_comment_id: 'cc-9' },
    ], prev);
    expect(out[0]!.labels).toEqual(prev[0]!.labels);
    expect(out[1]!.labels).toEqual([]);
    expect(out[1]!.comments!.map((c) => c.body)).toEqual(['hi']);
    expect([...serverCommentIds(out)]).toEqual(['cc-9']);
  });

  it('mergeThread carries labels, comments and processing to the thread file (old caches: none)', () => {
    const rows = mergeThread({
      server: [{ id: 'm1', kind: 'media', body: null, sender_id: 'office', created_at: '2026-11-27T10:00:00Z', withdrawn_at: null }],
      files: [sfile('e1', { processing: 'pending', comments: [{ id: 'a', body: 'b', author_id: ME, created_at: 'x', client_comment_id: null }] }), sfile('e2')],
      outbox: [], me: ME, staffLastReadAt: null, send: { online: true, paused: false, next_retry_at: null }, now: NOW,
    });
    const [a, b] = rows[0]!.images;
    expect([a!.processing, a!.comments.length, a!.labels]).toEqual(['pending', 1, []]);
    expect([b!.comments, b!.labels]).toEqual([[], []]);
  });
});

describe('labelChips / labelDescription', () => {
  it('one chip per category, people and the reading first, the operator tag marked as own', () => {
    expect(labelChips([
      { code: 'spot', name: 'Spot photo', source: 'operator', description: null },
      { code: 'rc', name: 'RC book', source: 'llm', description: 'RC' },
      { code: 'spot', name: 'Spot photo', source: 'llm', description: null },
      { code: 'dl', name: 'Driving licence', source: 'human', description: null },
    ])).toEqual([
      { key: 'dl', text: 'Driving licence', own: false },
      { key: 'rc', text: 'RC book', own: false },
      { key: 'spot', text: 'Spot photo', own: true },
    ]);
  });
  it('description: the LLM one first, else any active row that has one', () => {
    expect(labelDescription([
      { code: 'a', name: 'A', source: 'human', description: 'by a person' },
      { code: 'b', name: 'B', source: 'llm', description: 'by the reading' },
    ])).toBe('by the reading');
    expect(labelDescription([{ code: 'a', name: 'A', source: 'model', description: ' model text ' }])).toBe('model text');
    expect(labelDescription([{ code: 'a', name: 'A', source: 'llm', description: null }])).toBeNull();
  });
});

describe('fileInfoView', () => {
  it('"Being read…" only while processing is pending and nothing was found; the operator tag alone does not count', () => {
    const own = [{ code: 'spot', name: 'Spot photo', source: 'operator', description: null }];
    expect(fileInfoView(tf({ processing: 'pending', labels: own }), snap(), ME, NOW)).toMatchObject({ reading: true, chips: [{ text: 'Spot photo', own: true }] });
    expect(fileInfoView(tf({ processing: 'processing' }), snap(), ME, NOW).reading).toBe(true);
    expect(fileInfoView(tf({ processing: 'done' }), snap(), ME, NOW).reading).toBe(false);
    expect(fileInfoView(tf({ processing: 'failed' }), snap(), ME, NOW).reading).toBe(false);
    const found = fileInfoView(tf({ processing: 'pending', labels: [{ code: 'rc', name: 'RC book', source: 'llm', description: 'RC of the car' }] }), snap(), ME, NOW);
    expect([found.reading, found.description]).toEqual([false, 'RC of the car']);
  });

  it('server comments: "You" or "Office", with time; the phone\'s own follow until fetched', () => {
    const v = fileInfoView(
      tf({
        comments: [
          { id: 's1', body: 'Please retake', author_id: 'office-1', created_at: '2026-11-27T11:00:00Z', client_comment_id: null },
          { id: 's2', body: 'Done', author_id: ME, created_at: '2026-11-27T11:30:00Z', client_comment_id: 'cc-1' },
        ],
      }),
      snap([pending('cc-1', { state: 'sent' }), pending('cc-2'), pending('cc-3', { evidence_id: 'other' })]),
      ME, NOW,
    );
    expect(v.comments.map((c) => [c.author, c.body, c.time, c.status])).toEqual([
      ['Office', 'Please retake', '1 h ago', null],
      ['You', 'Done', '30 min ago', null],
      ['You', 'body cc-2', '2 min ago', COMMENT_STATUS.sending],
    ]);
    expect(v.count).toBe(3);
    expect(v.comments[2]!.removable).toBe(true);
    expect(v.canComment).toBe(true);
  });

  it('files still on the phone cannot be commented on', () => {
    const v = fileInfoView(tf({ evidenceId: null, processing: null }), snap([pending('x')]), ME, NOW);
    expect([v.canComment, v.cannotCommentText, v.comments, v.reading]).toEqual([false, NOT_SENT_COMMENT_TEXT, [], false]);
  });
});

describe('commentStatus', () => {
  it('offline, sending, retrying, session, held', () => {
    expect(commentStatus(pending('a'), { online: false, paused: false })).toEqual({ text: COMMENT_STATUS.offline, stuck: false, retry: false });
    expect(commentStatus(pending('a', { state: 'sending' }), { online: true, paused: false }).text).toBe(COMMENT_STATUS.sending);
    expect(commentStatus(pending('a', { last_error: 'transient:network' }), { online: true, paused: false })).toEqual({ text: COMMENT_STATUS.retrying, stuck: true, retry: true });
    expect(commentStatus(pending('a'), { online: true, paused: true }).text).toBe(COMMENT_STATUS.session);
    expect(commentStatus(pending('a', { state: 'held', held_reason: 'no_task' }), { online: true, paused: false })).toEqual({ text: COMMENT_STATUS.noTask, stuck: true, retry: true });
    expect(commentStatus(pending('a', { state: 'held', held_reason: 'rejected' }), { online: false, paused: false })).toEqual({ text: COMMENT_STATUS.rejected, stuck: true, retry: false });
    expect(commentStatus(pending('a', { state: 'sent' }), { online: true, paused: false }).text).toBeNull();
  });
  it('never says "failed"', () => {
    for (const t of Object.values(COMMENT_STATUS)) expect(t.toLowerCase()).not.toContain('fail');
  });
});

describe('badge, refetch trigger, sign-out', () => {
  it('commentBadge counts server comments', () => {
    expect(commentBadge(tf())).toBeNull();
    expect(commentBadge(tf({ comments: [{ id: 'a', body: 'b', author_id: null, created_at: 'x', client_comment_id: null }] }))).toBe('💬 1');
  });
  it('newlySentComments fires once per newly sent comment of the case', () => {
    const list = [pending('a', { state: 'sent' }), pending('b', { state: 'sent', case_id: 'c2' }), pending('c')];
    expect(newlySentComments(new Set(), list, 'c1')).toEqual(['a']);
    expect(newlySentComments(new Set(['a']), list, 'c1')).toBeNull();
  });
  it('commentSignOutView', () => {
    expect(commentSignOutView([pending('a', { state: 'sent' })]).allowed).toBe(true);
    const v = commentSignOutView([pending('a'), pending('b', { state: 'held', held_reason: 'no_task' })]);
    expect([v.allowed, v.count, v.title]).toEqual([false, 2, '2 comments not sent yet']);
    expect(v.body).toContain('lost');
    expect(commentSignOutView([pending('a')]).title).toBe('1 comment not sent yet');
  });
});
