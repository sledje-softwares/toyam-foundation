import { describe, expect, it } from 'vitest';
import { normalisePhone } from './phone.ts';

describe('normalisePhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
  ])('accepts %s', (raw, out) => expect(normalisePhone(raw)).toBe(out));

  it.each(['', '12345', '5876543210', '+14155550123', '98765432101', 'abcdefghij'])('rejects %s', (raw) =>
    expect(normalisePhone(raw)).toBeNull());
});
