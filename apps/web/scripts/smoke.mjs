// Role smoke test for the web routes. Plain Node ESM, fetch only.
// Env: WEB_URL (default http://localhost:3100), SUPABASE_URL, SUPABASE_ANON_KEY,
//      SMOKE_PASSWORD (email roles), SMOKE_FIELD_PHONE, SMOKE_FIELD_OTP.
// Email users: admin@example.com, orchestrator@example.com, office@example.com (override with SMOKE_<ROLE>_EMAIL).
const web = process.env.WEB_URL ?? "http://localhost:3100";
const sb = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const anon = process.env.SUPABASE_ANON_KEY;
const password = process.env.SMOKE_PASSWORD;
if (!anon || !password) {
  console.error("Set SUPABASE_ANON_KEY and SMOKE_PASSWORD (and optionally SMOKE_FIELD_PHONE / SMOKE_FIELD_OTP).");
  process.exit(2);
}
const routes = ["/", "/dashboard", "/intake", "/intake/failed", "/admin/users", "/admin/users/new", "/admin/insurers", "/admin/insurers/new", "/admin/checklists", "/admin/checklists/new", "/admin/audit-log", "/audit-log", "/dev/ui", "/account", "/tasks",
  // office pages; refs come from supabase/seed.sql (both owned by office@example.com: -000007 field work + re-investigation, -000008 report in progress)
  "/cases", "/cases/INV-2026-000007", "/tasks/new?case=INV-2026-000007", "/tasks/e0000000-0000-4000-8000-000000000104",
  "/reports", "/reports/INV-2026-000008", "/submissions",
  // D44: owned by Neel (office2), so office@example.com (Uma) must get 404
  "/cases/INV-2026-000006"];
const adminOnly = (r) => r.startsWith("/admin") || r === "/dev/ui";
const ok = { status: 200 };
const to = (p) => ({ status: [307, 308, 302, 303], loc: p });
// next.config redirects run before the middleware, so /audit-log moves first for everyone.
const common = (r) => (r === "/audit-log" ? to("/admin/audit-log") : r === "/" ? to("/dashboard") : null);
const anonExpect = (r) => (r === "/audit-log" ? to("/admin/audit-log") : to("/login"));
const staff = (r) => common(r) ?? (adminOnly(r) ? to("/forbidden") : ok);
const expectFor = {
  anonymous: anonExpect,
  field: anonExpect,
  office: (r) => (r === "/cases/INV-2026-000006" ? { status: 404, hidden: "Test Insured 103" } : staff(r)),
  orchestrator: staff,
  admin: (r) => common(r) ?? ok,
};

async function grant(body, query) {
  const res = await fetch(`${sb}/auth/v1/${query}`, {
    method: "POST",
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${query} ${res.status} ${await res.text()}`);
  return res.json();
}

async function session(role) {
  if (role === "anonymous") return null;
  if (role === "field") {
    const phone = process.env.SMOKE_FIELD_PHONE ?? "919800000001";
    const token = process.env.SMOKE_FIELD_OTP ?? "123456";
    await fetch(`${sb}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: anon, "content-type": "application/json" },
      body: JSON.stringify({ phone }),
    }).catch(() => {});
    return grant({ phone, token, type: "sms" }, "verify");
  }
  const email = process.env[`SMOKE_${role.toUpperCase()}_EMAIL`] ?? `${role}@example.com`;
  return grant({ email, password }, "token?grant_type=password");
}

// @supabase/ssr cookie: sb-<first hostname label>-auth-token = "base64-" + base64url(session JSON), chunked at 3180.
function cookieHeader(sess) {
  if (!sess) return "";
  const name = `sb-${new URL(sb).hostname.split(".")[0]}-auth-token`;
  const value = "base64-" + Buffer.from(JSON.stringify(sess)).toString("base64url");
  if (value.length <= 3180) return `${name}=${value}`;
  const parts = value.match(/.{1,3180}/g);
  return parts.map((p, i) => `${name}.${i}=${p}`).join("; ");
}

let mismatches = 0;
const rows = [];
for (const role of Object.keys(expectFor)) {
  let cookie = "";
  let userId = "";
  try {
    const sess = await session(role);
    userId = sess?.user?.id ?? "";
    cookie = cookieHeader(sess);
  } catch (e) {
    console.error(`${role}: sign-in failed: ${e.message}`);
    mismatches++;
    continue;
  }
  // The user's own detail page exercises /admin/users/[userId] with a real id.
  for (const r of userId ? [...routes, `/admin/users/${userId}`] : routes) {
    const res = await fetch(web + r, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const loc = res.headers.get("location");
    const path = loc ? new URL(loc, web).pathname : "";
    const want = expectFor[role](r);
    // notFound() can stream after a 200 header in dev: accept 404, or 200 whose body does not leak the case.
    const body = want.hidden && res.status === 200 ? await res.text() : "";
    const good = want.hidden ? res.status === 404 || (res.status === 200 && !body.includes(want.hidden)) : Array.isArray(want.status) ? want.status.includes(res.status) && path === want.loc : res.status === want.status && !loc;
    if (!good) mismatches++;
    rows.push(`${good ? "ok  " : "FAIL"} ${role.padEnd(12)} ${r.padEnd(34).slice(0, 60)} ${res.status}${path ? " -> " + path : ""}`);
  }
}
console.log(rows.join("\n"));
console.log(mismatches ? `\n${mismatches} mismatch(es)` : "\nall as expected");
process.exit(mismatches ? 1 : 0);
