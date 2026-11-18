import { describe, expect, it } from 'vitest';
import { parseLoginId } from './login.ts';

describe('parseLoginId', () => {
  it('reads an email, trimmed and lower-cased', () => {
    expect(parseLoginId('  Ravi.Kumar@Example.com ')).toEqual({ kind: 'email', email: 'ravi.kumar@example.com' });
  });

  it('reads a mobile number', () => {
    expect(parseLoginId('98765 43210')).toEqual({ kind: 'phone', phone: '+919876543210' });
  });

  it.each(['', '   ', 'ravi@', '@example.com', 'ravi@example', 'ra vi@example.com', '12345', 'abcdefghij'])(
    'rejects %j',
    (raw) => expect(parseLoginId(raw)).toBeNull(),
  );
});
