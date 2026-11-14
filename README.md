# toyam-foundation

Claims Investigation Platform for an insurance-claims investigation firm.

Insurer emails fill the right case template automatically, cases route themselves to office staff, field operators work in a familiar chat-style Android app (camera, gallery, share from any app), every file is read and labelled, and office staff build the report section by section with the relevant images beside them — then send it as PDF and/or Word on the insurer's own email thread.

## Status (2026-11-13)

| Item | State |
|---|---|
| Plan | Revised workflow, full scope (D14–D26) — `docs/03`, `docs/04` |
| M1 Foundation | Done: local Supabase stack, RLS, storage, web shell on Cloudflare Workers |
| M2 Admin | Database done; screens in progress (`docs/08-m2-admin-design.md`) |
| Database for M3–M8 | Done: templates, assignment, thread, processing queue, approvals, intake, staff notes / report progress, label-first processing (`20261113000100` … `20261114100000`); 390 pgTAP assertions |
| M6 Labelling | Prompt, model adapters and bake-off ready (`services/labeller/README.md`, D34); model choice waits for real labelled cases and the client's data-sharing answer (Q21) |
| M3 Email intake | Built and tested: push via Gmail forwarding + Email Routing, hourly IMAP safety net, `intake` edge function, rule parser, ingest (38 Node tests); review screen and live run pending (`services/intake/README.md`) |
| Templates | Drafts for IndusInd/Reliance motor OD and ICICI Lombard motor OD (`config/templates/`) |
| Field app, pipeline workers, report workspace | Not started |

## Documentation

| Document | Contents |
|---|---|
| [docs/01-business-context.md](docs/01-business-context.md) | Client, current process, volumes, pain points |
| [docs/02-automation-analysis.md](docs/02-automation-analysis.md) | Automation opportunities across all phases |
| [docs/03-phase1-scope.md](docs/03-phase1-scope.md) | Revised flow, scope, roles, lifecycle, gaps, findings from samples |
| [docs/04-build-plan.md](docs/04-build-plan.md) | Modules M0–M11, pieces, status, milestones, risks |
| [docs/05-architecture.md](docs/05-architecture.md) | Components, technology, intake / thread / report pipelines |
| [docs/06-data-model.md](docs/06-data-model.md) | Tables, status automation, database rules, access model |
| [docs/07-decisions-and-open-questions.md](docs/07-decisions-and-open-questions.md) | Decision log and open questions |
| [docs/08-m2-admin-design.md](docs/08-m2-admin-design.md) | M2 screens and solution design |
| [docs/09-template-model.md](docs/09-template-model.md) | Case templates and evidence categories (YAML reference) |
| [docs/10-processing-pipeline.md](docs/10-processing-pipeline.md) | OCR / labelling contract and worker API |
| [docs/11-field-app.md](docs/11-field-app.md) | Field app screens, sending, ticks, withdraw |

`CLAUDE.md` holds working context for AI-assisted development sessions.

## Repository layout

```
apps/web/              Next.js web app (Cloudflare Workers via OpenNext)
config/templates/      Evidence categories and case templates (YAML)
docs/                  Documentation
services/intake/       Gmail relay Worker, template loader, intake tests
services/labeller/     Vision labeller (prompt, adapters, scoring) and model bake-off
supabase/              Migrations, pgTAP tests, seed, local config, edge functions
```

Planned: `apps/field` (Expo field app), `services/pipeline` — see `docs/05-architecture.md`.
