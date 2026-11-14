import { describe, expect, it } from 'vitest';
import { relativeTime } from './time.ts';

const now = new Date('2026-11-14T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

describe('relativeTime', () => {
  it('formats', () => {
    expect(relativeTime(ago(20_000), now)).toBe('just now');
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5 min ago');
    expect(relativeTime(ago(2 * 3_600_000), now)).toBe('2 h ago');
    expect(relativeTime(ago(30 * 3_600_000), now)).toBe('Yesterday');
    expect(relativeTime(ago(3 * 86_400_000), now)).toBe('3 days ago');
  });
  it('handles empty, bad and future input', () => {
    expect(relativeTime(null, now)).toBe('');
    expect(relativeTime('nope', now)).toBe('');
    expect(relativeTime(ago(-60_000), now)).toBe('just now');
  });
});
