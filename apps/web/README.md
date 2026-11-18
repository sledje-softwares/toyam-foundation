# apps/web

Web app for admin, orchestrator and office staff (Next.js, App Router, TypeScript, Tailwind).

## Setup

Requires Node 22 (`nvm use` at the repo root).

```bash
npm install                       # from the repo root (npm workspaces)
cp apps/web/.env.example apps/web/.env.local
```

Set in `.env.local` (anon / publishable key only; never a service-role key):

- `NEXT_PUBLIC_SUPABASE_URL` (local default `http://127.0.0.1:54321`)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (from `supabase status`)

## Run

```bash
npm run dev                       # from the repo root, http://localhost:3000
npm run build && npm run lint && npm run typecheck
```

## Notes

- Sign-in is email + password for staff. Field users and inactive profiles are signed out.
- `middleware.ts` refreshes the session and redirects anonymous visitors to `/login`.
- Roles are enforced in layouts/pages (`lib/auth.ts`); row-level security is the real guard.
- `@shared/*` imports `supabase/functions/_shared/*` (tsconfig `paths` + `allowImportingTsExtensions`, same alias
  in `vitest.config.ts`; Turbopack resolves it because the repo root, where `package-lock.json` lives, is its root).
  Used for the report writers; those files follow the `_shared` rules (Deno + Node type stripping).
- Report generation and preview run in the browser (`lib/report-build`, docs/13 "Built in the browser"):
  `lib/supabase/browser.ts` is the browser client (anon key + the user's session only), the writers run in a Web
  Worker (`lib/report-build/worker.ts`) and load on the first Generate / Preview click.
- `lib/database.types.ts` is generated; regenerate it after schema changes with `npx -y supabase@3.1.0 gen types typescript --local > apps/web/lib/database.types.ts` (run from the repo root).

## Cloudflare Workers (OpenNext)

`npm run preview` builds and runs locally on the Workers runtime; `npm run deploy` publishes
(needs `wrangler login`, not done here). Set the two env vars as Worker variables.
`npm run cf-typegen` regenerates `cloudflare-env.d.ts`.
