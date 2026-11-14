/**
 * Indian mobile to E.164 (+91XXXXXXXXXX). Same rules as `normalisePhone` in
 * supabase/functions/_shared/admin-users/logic.ts; keep the two in step.
 */
export function normalisePhone(raw: string): string | null {
  let d = raw.trim().replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) {
    if (!d.startsWith('+91')) return null;
    d = d.slice(3);
  } else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}
