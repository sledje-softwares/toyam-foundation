import { normalisePhone } from './phone';

/**
 * What the operator typed in the sign-in box: an email (FIELD_SIGN_IN = email_password, the hosted setting)
 * or an Indian mobile number (mobile_password, the local seed). Anything with an "@" is treated as an email.
 */
export type LoginId = { kind: 'email'; email: string } | { kind: 'phone'; phone: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseLoginId(raw: string): LoginId | null {
  const v = raw.trim();
  if (v.includes('@')) {
    const email = v.toLowerCase();
    return EMAIL.test(email) && email.length <= 254 ? { kind: 'email', email } : null;
  }
  const phone = normalisePhone(v);
  return phone ? { kind: 'phone', phone } : null;
}
