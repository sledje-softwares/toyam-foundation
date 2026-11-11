# toyam-foundation

Claims Investigation Platform for an insurance-claims investigation firm.

The platform replaces a manual, email-and-WhatsApp-driven workflow with a single system that receives cases from insurers by email, lets the orchestrator assign and track investigations, lets field operators capture verifiable evidence on a mobile app, and lets the office prepare and submit reports.

## Status

| Item | State |
|---|---|
| Phase | Phase 1 — planning complete, build not started |
| Database schema | Drafted and tested locally (`supabase/migrations/`) |
| Application code | Not started |

## Documentation

| Document | Contents |
|---|---|
| [docs/01-business-context.md](docs/01-business-context.md) | Client, current process, volumes, pain points |
| [docs/02-automation-analysis.md](docs/02-automation-analysis.md) | Step-by-step automation opportunities across all phases |
| [docs/03-phase1-scope.md](docs/03-phase1-scope.md) | Phase 1 objective, scope, roles, case lifecycle |
| [docs/04-build-plan.md](docs/04-build-plan.md) | Modules, pieces, estimates, milestones, client inputs, risks |
| [docs/05-architecture.md](docs/05-architecture.md) | Proposed technology, components, email intake options, storage sizing |
| [docs/06-data-model.md](docs/06-data-model.md) | Entities, design rules, access model |
| [docs/07-decisions-and-open-questions.md](docs/07-decisions-and-open-questions.md) | Decision log and unresolved questions |

`CLAUDE.md` holds working context for AI-assisted development sessions.

## Repository layout

```
docs/                    Project documentation
supabase/migrations/     Database migrations (PostgreSQL / Supabase)
```

Application folders (`apps/web`, `apps/field`, `services/intake`) will be added as the build begins; see `docs/05-architecture.md`.
