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
const routes = ["/", "/dashboard", "/intake", "/intake/failed", "/admin/users", "/admin/audit-log", "/audit-log", "/dev/ui", "/account", "/tasks"];
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
  office: staff,
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
  try {
    cookie = cookieHeader(await session(role));
  } catch (e) {
    console.error(`${role}: sign-in failed: ${e.message}`);
    mismatches++;
    continue;
  }
  for (const r of routes) {
    const res = await fetch(web + r, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const loc = res.headers.get("location");
    const path = loc ? new URL(loc, web).pathname : "";
    const want = expectFor[role](r);
    const good = Array.isArray(want.status) ? want.status.includes(res.status) && path === want.loc : res.status === want.status && !loc;
    if (!good) mismatches++;
    rows.push(`${good ? "ok  " : "FAIL"} ${role.padEnd(12)} ${r.padEnd(17)} ${res.status}${path ? " -> " + path : ""}`);
  }
}
console.log(rows.join("\n"));
console.log(mismatches ? `\n${mismatches} mismatch(es)` : "\nall as expected");
process.exit(mismatches ? 1 : 0);
