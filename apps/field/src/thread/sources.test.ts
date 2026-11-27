import { describe, expect, it } from 'vitest';
import { createLoader, RETRY_AFTER_MS, type ViewLink } from './loader';
import type { ThreadFile } from './model';
import { batches, cacheFileName, cacheKey, firstAvailable, prunePlan, sourcePlan, withoutFailed, type Source } from './sources';
import { clampPan, doubleTapScale, isDoubleTap, MAX_SCALE, pinchScale } from './zoom';

const tf = (over: Partial<ThreadFile> = {}): ThreadFile => ({
  key: 'sha1', sha256: 'sha1', evidenceId: null, kind: 'image', name: 'a.jpg', sizeBytes: 5_000_000, mime: 'image/jpeg',
  local: null, copies: [], state: null, progress: null, labels: [], comments: [], processing: null, ...over,
});

describe('sourcePlan', () => {
  it('thumb of a pending photo: cache, then the 384 copy, then the original', () => {
    const plan = sourcePlan(tf({ local: { original: 'file:///o.jpg', w384: 'file:///c384.jpg', w1600: null } }), 'thumb');
    expect(plan).toEqual([
      { type: 'cache', key: 'sha1-w384' },
      { type: 'local', uri: 'file:///c384.jpg' },
      { type: 'local', uri: 'file:///o.jpg' },
    ]);
  });
  it('thumb of a server photo: the 384 copy only, never a big original', () => {
    expect(sourcePlan(tf({ evidenceId: 'e1', copies: [384, 1600] }), 'thumb').at(-1))
      .toEqual({ type: 'remote', evidenceId: 'e1', variant: 'w384', key: 'sha1-w384' });
    expect(sourcePlan(tf({ evidenceId: 'e1', copies: [] }), 'thumb').some((s) => s.type === 'remote')).toBe(false);
    expect(sourcePlan(tf({ evidenceId: 'e1', copies: [], sizeBytes: 800_000 }), 'thumb').some((s) => s.type === 'remote')).toBe(true);
  });
  it('full: 1600 copy first, the thumbnail as a last resort', () => {
    const plan = sourcePlan(tf({ evidenceId: 'e1', copies: [384, 1600] }), 'full');
    expect(plan[0]).toEqual({ type: 'cache', key: 'sha1-w1600' });
    expect(plan[1]).toEqual({ type: 'remote', evidenceId: 'e1', variant: 'w1600', key: 'sha1-w1600' });
    expect(plan.at(-1)).toEqual({ type: 'remote', evidenceId: 'e1', variant: 'w384', key: 'sha1-w384' });
    const noCopy = sourcePlan(tf({ evidenceId: 'e1', copies: [], sizeBytes: 3_000_000 }), 'full');
    expect(noCopy[1]).toEqual({ type: 'remote', evidenceId: 'e1', variant: 'original', key: 'sha1-original' });
  });
});

describe('firstAvailable', () => {
  const plan: Source[] = [
    { type: 'cache', key: 'k-w384' },
    { type: 'local', uri: 'file:///c.jpg' },
    { type: 'remote', evidenceId: 'e', variant: 'w384', key: 'k-w384' },
  ];
  it('cache hit first', () => {
    expect(firstAvailable(plan, (k) => k === 'k-w384', true)?.show).toEqual({ type: 'cache', key: 'k-w384' });
  });
  it('local next; then a download only when online; nothing offline', () => {
    expect(firstAvailable(plan, () => false, true)?.show).toEqual({ type: 'local', uri: 'file:///c.jpg' });
    const rest = withoutFailed(plan, [plan[1]!]);
    expect(firstAvailable(rest, () => false, true)?.fetch).toEqual(plan[2]);
    expect(firstAvailable(rest, () => false, false)).toBeNull();
  });
  it('a downloaded remote entry shows from the cache', () => {
    const c = firstAvailable([plan[2]!], (k) => k === 'k-w384', false);
    expect(c).toEqual({ show: { type: 'cache', key: 'k-w384' }, fetch: null, from: plan[2] });
  });
});

describe('cache files', () => {
  it('names are plain keys only', () => {
    expect(cacheFileName(cacheKey('ab12', 'w384'))).toBe('ab12-w384.img');
    expect(cacheFileName('../x')).toBeNull();
    expect(cacheFileName('a/b')).toBeNull();
  });
  it('prune: oldest first down to the cap', () => {
    const e = [{ name: 'a', size: 50, mtime: 3 }, { name: 'b', size: 50, mtime: 1 }, { name: 'c', size: 50, mtime: 2 }];
    expect(prunePlan(e, 200)).toEqual([]);
    expect(prunePlan(e, 100)).toEqual(['b']);
    expect(prunePlan(e, 10)).toEqual(['b', 'c', 'a']);
  });
  it('batches of 50', () => {
    expect(batches(Array.from({ length: 120 }, (_, i) => i)).map((b) => b.length)).toEqual([50, 50, 20]);
  });
});

describe('loader', () => {
  function setup(reply: (ids: string[]) => ViewLink[], downloadOk = true) {
    const calls: { ids: string[]; variant: string }[] = [];
    const downloads: string[] = [];
    let t = 0;
    const pending: (() => void)[] = [];
    const l = createLoader({
      links: async (ids, variant) => { calls.push({ ids, variant }); return reply(ids); },
      download: async (key) => { downloads.push(key); return downloadOk; },
      now: () => t,
      schedule: (fn) => pending.push(fn),
    });
    return { l, calls, downloads, flush: () => pending.splice(0).forEach((f) => f()), advance: (ms: number) => { t += ms; } };
  }
  const ok = (ids: string[]) => ids.map((id) => ({ id, url: `https://r2/${id}`, sha256: 'x' }));

  it('one evidence-view call per variant for requests made together; one download per key', async () => {
    const s = setup(ok);
    const a = s.l.fetch('e1', 'w384', 'k1');
    const a2 = s.l.fetch('e1', 'w384', 'k1');
    const b = s.l.fetch('e2', 'w384', 'k2');
    const c = s.l.fetch('e3', 'w1600', 'k3');
    s.flush();
    expect(await Promise.all([a, a2, b, c])).toEqual([true, true, true, true]);
    expect(s.calls).toEqual([{ ids: ['e1', 'e2'], variant: 'w384' }, { ids: ['e3'], variant: 'w1600' }]);
    expect(s.downloads.sort()).toEqual(['k1', 'k2', 'k3']);
  });
  it('not_found / no link / failed download → false, and not asked again for a while', async () => {
    const s = setup((ids) => ids.map((id) => ({ id, error: 'not_found' })));
    const p = s.l.fetch('e1', 'w384', 'k1');
    s.flush();
    expect(await p).toBe(false);
    expect(await s.l.fetch('e1', 'w384', 'k1')).toBe(false);
    expect(s.calls).toHaveLength(1);
    s.advance(RETRY_AFTER_MS + 1);
    const again = s.l.fetch('e1', 'w384', 'k1');
    s.flush();
    await again;
    expect(s.calls).toHaveLength(2);
  });
  it('a throwing evidence-view call resolves false', async () => {
    const s = setup(() => { throw new Error('offline'); });
    const p = s.l.fetch('e1', 'w384', 'k1');
    s.flush();
    expect(await p).toBe(false);
  });
});

describe('zoom maths', () => {
  it('pinch scales within 1–4', () => {
    expect(pinchScale(1, 100, 200)).toBe(2);
    expect(pinchScale(2, 100, 10)).toBe(1);
    expect(pinchScale(3, 100, 400)).toBe(MAX_SCALE);
  });
  it('pan stays inside the overflow; none at 1×', () => {
    expect(clampPan(500, -500, 2, 400, 600)).toEqual({ x: 200, y: -300 });
    expect(clampPan(50, 50, 1, 400, 600)).toEqual({ x: 0, y: 0 });
  });
  it('double tap toggles and needs two close taps', () => {
    expect(doubleTapScale(1)).toBe(2.5);
    expect(doubleTapScale(3)).toBe(1);
    expect(isDoubleTap({ t: 0, p: { x: 10, y: 10 } }, 200, { x: 15, y: 12 })).toBe(true);
    expect(isDoubleTap({ t: 0, p: { x: 10, y: 10 } }, 500, { x: 10, y: 10 })).toBe(false);
    expect(isDoubleTap(null, 0, { x: 0, y: 0 })).toBe(false);
  });
});
