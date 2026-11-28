import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapLimit } from '../../../supabase/functions/_shared/concurrency.ts';

const tick = () => new Promise((r) => setTimeout(r, 2));

describe('mapLimit', () => {
  it('keeps order and never exceeds the limit', async () => {
    let live = 0, peak = 0;
    const r = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      peak = Math.max(peak, ++live);
      await tick();
      live--;
      return n * 2;
    });
    assert.deepEqual(r, [2, 4, 6, 8, 10, 12, 14]);
    assert.equal(peak, 3);
  });
  it('handles empty input and a limit above the length', async () => {
    assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
    assert.deepEqual(await mapLimit([1, 2], 10, async (x) => x), [1, 2]);
  });
  it('stops starting work after a failure and re-throws it', async () => {
    const started: number[] = [];
    await assert.rejects(mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      await tick();
      if (n === 2) throw new Error('boom');
      return n;
    }), /boom/);
    assert.ok(started.length < 6);
  });
});
