# 08 — M2 Administration & Master Data: UX and Solution Design

Status: **proposed** (2026-11-11). Covers build-plan pieces 2.1–2.4 and the information architecture of the whole staff web app, so that M3–M9 screens slot into one navigation and one set of components.

Inputs: `03-phase1-scope.md`, `04-build-plan.md`, `06-data-model.md`, `07-decisions-and-open-questions.md`, migrations up to `20261111130000`, and the web shell in `apps/web` (`app/(app)/layout.tsx`, `lib/nav.ts`, `lib/auth.ts`, `components/nav-links.tsx`).

## 0. Key decisions (summary)

| # | Decision |
|---|---|
| K1 | Admin is a **superset role** in the web app: sees every screen, plus the Admin group. RLS already gives admins full access; hiding screens would only force a second account. |
| K2 | All user **sign-in-level** actions (create, change email/mobile, reset password, deactivate/reactivate) go through one server-side function `admin-users` that verifies the caller is an active admin and only then uses the auth admin API. Profile-only edits (name, role, region) are plain RLS-protected updates. No service-role key in `apps/web`. |
| K3 | No emails are sent by the system for accounts. Admin-set **temporary passwords**, shown once, shared by phone. Users change their own password at `/account`. |
| K4 | Field operators sign in with **mobile number + password** now (no SMS cost) and can move to **mobile OTP** later with no data change — the mobile number is always stored on the sign-in record. Fallback if mobile+password is not available on the hosted plan: email + password. |
| K5 | Deactivation = `profiles.is_active = false` (instant loss of data access through RLS) **plus** a sign-in block on the account (stops new sign-ins and session refresh, i.e. remote sign-out for the field app). Users are never deleted. |
| K6 | Checklist templates are **edited in place and saved atomically** (one database function). Tasks keep their own copy, so saving never changes existing tasks; the editor says so and shows how many open tasks hold an earlier copy. A `version` counter and audit triggers record each save. Templates are never deleted, only taken out of use. |
| K7 | Several checklists per claim type are allowed (e.g. "Hospital visit", "Insured residence visit"); an insurer-specific checklist with the **same name** overrides the all-insurer one for that insurer. Requires replacing `uq_active_template` (conditional on M0 0.3, default yes). |
| K8 | Initial master data (10 insurers, agreed checklists, staff) is entered **through the admin UI** in a joint session with the client admin. Dev uses `seed.sql`. No CSV import. |
| K9 | No UI component library. Small set of hand-built components on native elements (`<table>`, `<dialog>`, `<select>`) + Tailwind tokens. `zod` for validation shared by server actions. |
| K10 | Filters, search, sort and page live in **URL search params** on every list (shareable, back button works). |

### Session 5 decisions (2026-11-14)

- **Build order** (replaces the order in section 5): foundation first (T2 UI components, T3 DataTable / FilterBar / Pagination, T4 shell: admin layout, audit log under `/admin`, nav badge slot); then 3.9 intake review and 3.10 failed mail on top of it; then users (T5-T10), insurers (T11-T12), checklists (T13-T15), then 2.6 (section 2.6 below, to be reviewed before it is built). T16 stays last.
- **Resolved open points**: O3 region is free text with suggestions; O9 no forced password change; O10 orchestrators get no insurer screens. K9 stands (no UI library). The 2.6 screens are admin-only.
- **Checklist editor (T13-T15)** is kept as designed, plus an **evidence-category select per item** (`checklist_template_items.category_id` -> `evidence_categories`, build plan 2.3; `save_checklist_template()` already accepts an optional item `category_id`, and `apply_checklist_template()` copies it to `task_checklist_items`). The editor works on `checklist_templates` through `save_checklist_template()` / `activate_checklist_template()` and never edits loaded `case_template*` rows by hand (CLAUDE.md rule 8); the one exception is the defined re-point inside `activate_checklist_template()` (D42). The template YAML's default field checklist stays the source for template-driven cases (D20). **Resolved (D41, 2026-11-14) — D20-O1:** the items stay in the checklist tables and the editor (T13–T15), with the evidence category per item; ticking is driven by labelling. Original question: `load_case_template()` does not create checklists; it links `case_template_checklists` to existing in-use `checklist_templates` by name (insurer-specific first, else all-insurer). So the items of a YAML "default checklist" live in `checklist_templates` and are maintained in this editor, not in YAML. Which of the two is the source of the items, and who creates the rows the loader links to, is undecided and needs the user's answer before T13.

---

## 1. Information architecture (whole staff web app)

### 1.1 Navigation

Left sidebar (existing shell), two groups. Order follows the case lifecycle.

```
┌───────────────────────────┐
│ Claims Investigation      │
│                           │
│  Dashboard                │  M8
│  Intake            (12)   │  M3   count = extractions pending review
│  Cases                    │  M4
│  Tasks                    │  M4   open tasks; default "Assigned to me"
│  Reports            (3)   │  M6   count = cases awaiting my review
│  Submissions              │  M7
│                           │
│  ADMIN                    │  (admin only)
│  Users                    │  M2
│  Insurers                 │  M2
│  Checklists               │  M2
│  Audit log                │  M9
│ ───────────────────────── │
│  Asha Rao                 │
│  Admin                    │
│  My account · Sign out    │
└───────────────────────────┘
```

Count badges are added by the module that owns them (M3, M6); M2 only adds the `badge` slot to `NavItem`.

### 1.2 Role visibility

| Nav item | Admin | Orchestrator | Office | Field |
|---|---|---|---|---|
| Dashboard | ✓ | ✓ | ✓ | — (no web access) |
| Intake | ✓ | ✓ | ✓ | — |
| Cases | ✓ | ✓ | ✓ | — |
| Tasks | ✓ | ✓ | ✓ | — |
| Reports | ✓ | ✓ | ✓ | — |
| Submissions | ✓ | ✓ | — (sees submission on case) | — |
| Users, Insurers, Checklists, Audit log | ✓ | — | — | — |
| My account | ✓ | ✓ | ✓ | — (field app, M5) |

In-screen actions are restricted further by the owning module (e.g. only orchestrator/admin see "Record submission").

### 1.3 URL scheme (every Phase 1 screen)

Case URLs use the human-readable `case_ref` (unique) so staff can read it out on the phone. Case sub-pages are nested routes under one case layout (header + tabs).

| Screen | Route | Module | Notes |
|---|---|---|---|
| Sign in | `/login` | M1 | exists |
| Access denied | `/forbidden` | M1 | exists |
| Dashboard | `/dashboard` | M8 | `?insurer=` |
| Intake queue | `/intake` | M3 | `?view=pending\|unknown_sender\|failed\|all&q=` |
| Intake review | `/intake/[emailId]` | M3 | pre-filled form, confirm → case |
| Case list | `/cases` | M4 | `?status=&insurer=&due=overdue\|soon&q=&sort=&page=` |
| New case (manual fallback) | `/cases/new` | M4 | when a case arrives outside email |
| Case overview | `/cases/[caseRef]` | M4 | parties, entities, key dates |
| Case tasks | `/cases/[caseRef]/tasks` | M4 | |
| New task / re-investigation | `/cases/[caseRef]/tasks/new` | M4 | `?parent=[taskId]` for re-investigation |
| Task detail | `/cases/[caseRef]/tasks/[taskId]` | M4 | assignment, checklist |
| Case evidence | `/cases/[caseRef]/evidence` | M6 | `?task=&item=&flagged=1` |
| Case emails | `/cases/[caseRef]/emails` | M3/M4 | |
| Case report | `/cases/[caseRef]/report` | M6 | versions, upload, hand-off |
| Case submission | `/cases/[caseRef]/submission` | M7 | |
| Case history | `/cases/[caseRef]/history` | M4 | status history + audit |
| Tasks | `/tasks` | M4 | `?assignee=me\|[id]&status=&kind=` |
| Report review queue | `/reports` | M6 | `?stage=office_review\|orchestrator_review` |
| Submissions | `/submissions` | M7 | `?ack=pending` |
| Users | `/admin/users` | M2 | `?role=&status=&region=&q=` |
| Add user | `/admin/users/new` | M2 | |
| User detail | `/admin/users/[userId]` | M2 | |
| Insurers | `/admin/insurers` | M2 | `?status=&channel=&q=` |
| Add insurer | `/admin/insurers/new` | M2 | |
| Insurer detail | `/admin/insurers/[insurerId]` | M2 | |
| Checklists | `/admin/checklists` | M2 | `?claim_type=&insurer=&status=` |
| New checklist | `/admin/checklists/new` | M2 | `?copy=[templateId]` to duplicate |
| Checklist editor | `/admin/checklists/[templateId]` | M2 | editor + preview |
| Audit log | `/admin/audit-log` | M9 | `?table=&record=&actor=&from=&to=&page=` |
| My account | `/account` | M2 | change own password |

Hospitals/garages/doctors (`entities`) have no top-level screen in Phase 1; they are added and linked from the case (M4 4.3).

### 1.4 Changes the shell needs

1. `lib/nav.ts`: add `admin` to Intake and Reports; add `/tasks` (M4, all staff); move Audit log to `/admin/audit-log` with `group: "Admin"`; add optional `badge?: "intake" | "reports"`.
2. `components/nav-links.tsx`: remove the `/audit-log` special-casing (it is now a normal Admin item).
3. Move `app/(app)/audit-log/page.tsx` → `app/(app)/admin/audit-log/page.tsx`.
4. Add `app/(app)/admin/layout.tsx` calling `requireRole(["admin"])` once for every admin route (defence in depth; RLS is still the real guard).
5. Sidebar footer: "My account" link → `/account`; show role with a display label (`ROLE_LABELS`: Admin, Orchestrator, Office staff, Field operator) instead of `capitalize`.
6. Layout: add a "Skip to main content" link, `<main id="main">`, and the `<Toaster />`.
7. `main` content: full width for tables (`max-w-screen-2xl`); forms constrain themselves to `max-w-3xl`.
8. Regenerate `lib/database.types.ts` with the type generator after the M2 migration.

---

## 2. M2 screens

All wireframes show the content area only (the sidebar is the shell). `[ Button ]` = button, `[x]` = checkbox, `[ … ▾]` = select, `( )` = radio.

### 2.1 Users

#### 2.1.1 Users list — `/admin/users` (admin)

Purpose: see who has access, filter field operators by region, find a person quickly, spot inactive accounts.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Admin › Users                                                 [ + Add user ] │
│ Users                                                                        │
├──────────────────────────────────────────────────────────────────────────────┤
│ [ Search name, email or mobile… ]  Role [ All ▾]  Status [ Active ▾]         │
│ Region [ All ▾]                                   14 users · Clear filters   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Name ▲            Role            Region   Email / Mobile          Open  Last│
│                                                                    tasks sign-in│
│ Asha Rao          Admin           —        asha@firm.in            —   Today │
│ Farid Khan        Field operator  Pune     +91 98000 00001         2   2 Nov │
│ Uma Patil         Office staff    —        uma@firm.in             1   Today │
│ Vijay More  ⦸Inactive  Field op.  Nashik   +91 98000 00007         0   9 Oct │
│ …                                                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

| Column | Source |
|---|---|
| Name (link to detail) | `profiles.full_name` |
| Role | `profiles.role` → display label |
| Region | `profiles.region` |
| Email / Mobile | `auth.users.email`, `auth.users.phone` via `admin_list_users()` (staff show email first, field show mobile first) |
| Open tasks | count of `tasks` where `assignee_id = id` and `status in (pending, in_progress)` |
| Last sign-in | `auth.users.last_sign_in_at` via `admin_list_users()`; IST, "Today 14:05" / "2 Nov" |
| Status badge | "Inactive" when `profiles.is_active = false` |

- Filters: Role (All, Admin, Orchestrator, Office staff, Field operator), Status (Active — default, Inactive, All), Region (distinct `profiles.region` values), search (name, email, mobile; case-insensitive, digits-only match for mobile).
- Fewer than ~100 rows: load all, filter in the page; no pagination. State is still in the URL.
- Sort: name (default), role, region, last sign-in.
- Empty (no users other than me): "Only you have access so far." + [ Add user ]. Empty (filters): "No users match these filters." + [ Clear filters ].
- Loading: table skeleton (8 rows). Error: "Users could not be loaded." + [ Try again ].

#### 2.1.2 Add user — `/admin/users/new` (admin)

```
┌──────────────────────────────────────────────────────────────┐
│ Admin › Users › Add user                                     │
│ Add user                                                     │
├──────────────────────────────────────────────────────────────┤
│ Full name *        [ Farid Khan                        ]     │
│ Role *             ( ) Admin  ( ) Orchestrator               │
│                    ( ) Office staff  (•) Field operator      │
│ Region *           [ Pune                     ▾ suggest ]    │
│                    Used to pick operators for a case area.   │
│ ─ Sign-in details ─────────────────────────────────────────  │
│ Mobile number *    [ +91 | 98000 00001                 ]     │
│                    Field operators sign in with this number. │
│ Email              [                                    ]    │
│                    Optional for field operators.             │
│                                                              │
│ A temporary password is created when you save.               │
│                                     [ Cancel ] [ Add user ]  │
└──────────────────────────────────────────────────────────────┘
```

| Field | Type / control | Validation | Maps to |
|---|---|---|---|
| Full name | text | required, trimmed, 2–80 chars | `app_metadata.full_name` → `profiles.full_name` (trigger) |
| Role | radio | required, one of `user_role` | `app_metadata.role` → `profiles.role` |
| Region | text with suggestions (`<datalist>` of existing regions) | required for Field operator, optional otherwise, ≤ 60 chars, stored trimmed in title case | `app_metadata.region` → `profiles.region` |
| Mobile number | tel, fixed `+91` prefix | Indian mobile: 10 digits starting 6–9 after removing spaces/dashes/leading 0/+91; **required for Field operator**, optional for staff; unique | auth `phone` (E.164, `phone_confirm: true`) → `profiles.phone` (trigger) |
| Email | email | **required for Admin/Orchestrator/Office** (web sign-in), optional for Field operator; lower-cased; unique | auth `email` (`email_confirm: true`) |

Requirement per field sign-in method (constant `FIELD_SIGN_IN` in `lib/auth-config.ts`, mirrored as a function secret):

| `FIELD_SIGN_IN` | Field operator: mobile | Field operator: email | Password created |
|---|---|---|---|
| `mobile_password` (default) | required | optional | yes |
| `mobile_otp` | required | optional | no (none shown) |
| `email_password` (fallback) | required (contact) | required | yes |

Staff always: email required, password created. The form re-labels hints when the role changes.

On save → server action → `admin-users` `create`. Success: redirect to the user detail page and open the **temporary password dialog**:

```
┌────────────────────────────────────────────────────┐
│ Farid Khan can now sign in                         │
│                                                    │
│ Mobile number   +91 98000 00001                    │
│ Temporary password   Kp7m-Rw4t-Qx9z   [ Copy ]     │
│                                                    │
│ Share this by phone or in person. It will not be   │
│ shown again. Ask them to change it after signing   │
│ in.                                                │
│                                         [ Done ]   │
└────────────────────────────────────────────────────┘
```

Errors (inline, at the field): "This mobile number is already used by Vijay More." / "This email is already used by another user." / "Enter a 10-digit Indian mobile number." Generic: "The user was not added. Nothing was saved. Try again." (create is all-or-nothing: the profile is created by the trigger in the same transaction as the account).

#### 2.1.3 User detail / edit — `/admin/users/[userId]` (admin)

Four independent sections, each with its own Save so a mistake in one does not block the others.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Admin › Users › Farid Khan                                               │
│ Farid Khan   [Field operator] [Active]          Added 12 Nov 2026         │
│                                                  Last sign-in 2 Nov 09:14 │
├──────────────────────────────────────────────────────────────────────────┤
│ Profile                                                                  │
│   Full name  [ Farid Khan          ]                                     │
│   Role       [ Field operator ▾]                                         │
│   Region     [ Pune             ]                    [ Save profile ]    │
├──────────────────────────────────────────────────────────────────────────┤
│ Sign-in details                                                          │
│   Mobile     [ +91 | 98000 00001 ]                                       │
│   Email      [                    ]              [ Save sign-in details ]│
├──────────────────────────────────────────────────────────────────────────┤
│ Password                                                                 │
│   Create a new temporary password. The current one stops working.        │
│                                                  [ Reset password ]      │
├──────────────────────────────────────────────────────────────────────────┤
│ Access                                                                   │
│   2 open tasks are assigned to Farid.  View tasks →                      │
│                                                  [ Deactivate user ]     │
└──────────────────────────────────────────────────────────────────────────┘
```

| Section | Fields | Mechanism | Notes |
|---|---|---|---|
| Profile | `profiles.full_name`, `profiles.role`, `profiles.region` | server action, RLS update on `profiles` (admin policy), `.select()` to confirm 1 row | Audit log records the admin as actor |
| Sign-in details | auth `email`, `phone` | `admin-users` `update_login` | phone change syncs `profiles.phone` via existing trigger |
| Password | — | `admin-users` `reset_password` | shows the temporary password dialog; hidden when `FIELD_SIGN_IN = mobile_otp` and role is field |
| Access | `profiles.is_active` + sign-in block | `admin-users` `set_active` | |

Role-change warnings (inline, before save, not blocking):
- From Field operator to a staff role with open tasks: "Farid has 2 open field tasks. They stay assigned to him but he will no longer be able to use the field app. Reassign them in Cases first."
- To Field operator: "Uma will lose access to this web app and can only use the field app." + Region becomes required.
- Own account: Role select and Deactivate are disabled with the hint "You can't change your own role or deactivate yourself."
- Last active admin: database rejects; message "There must be at least one active admin."

Confirmations:

| Action | Dialog title | Body | Confirm button |
|---|---|---|---|
| Deactivate | Deactivate Farid Khan? | "Farid will be signed out on all devices and can't sign in. His cases, tasks and evidence stay as they are. 2 open tasks are still assigned to him." | **Deactivate user** (red; Cancel has initial focus) |
| Reactivate | Reactivate Farid Khan? | "Farid will be able to sign in again with his existing password." | **Reactivate user** |
| Reset password | Reset password for Farid Khan? | "The current password stops working immediately." | **Reset password** |
| Change mobile/email | Change sign-in details? | "Farid must use the new mobile number / email the next time he signs in." | **Save sign-in details** |

Toasts: "Profile saved." / "Sign-in details saved." / "Farid Khan deactivated." / "Farid Khan reactivated."

Inactive user: header badge "Inactive"; Access section shows [ Reactivate user ]; Password section hidden.

#### 2.1.4 My account — `/account` (all staff)

```
┌──────────────────────────────────────────────────────┐
│ My account                                           │
│ Asha Rao · Admin · asha@firm.in                      │
├──────────────────────────────────────────────────────┤
│ Change password                                      │
│   New password *      [                    ]         │
│   Confirm password *  [                    ]         │
│   At least 10 characters with upper- and lower-case  │
│   letters and a number.                              │
│                               [ Change password ]    │
└──────────────────────────────────────────────────────┘
```

Server action calls the auth "update user" with the user's own session (no admin rights). Matches `config.toml` (`minimum_password_length = 10`, `lower_upper_letters_digits`). Success toast: "Password changed."

#### 2.1.5 Server-side mechanism: `admin-users` function

Location `supabase/functions/admin-users/index.ts`; `verify_jwt = true` in `config.toml`. **Built (T5): the exact request/response contract and error codes are in `supabase/functions/admin-users/README.md`.** Called only from Next.js server actions with the signed-in user's session (`supabase.functions.invoke("admin-users", { body })` attaches the user's access token). The service-role key exists only inside the function runtime.

Request: `POST`, JSON `{ action, ... }`. Response: `200 { ok: true, ... }` or `{ ok: false, error: { code, message, field? } }` with status 400/401/403/409/502.

| Action | Body | Does |
|---|---|---|
| `create` | `full_name, role, region?, email?, phone?` | validate → generate temporary password (unless field + `mobile_otp`) → `auth.admin.createUser({ email, phone, password, email_confirm: true, phone_confirm: true, app_metadata: { role, full_name, region } })` → trigger creates active profile → returns `{ user_id, temporary_password? }` |
| `update_login` | `user_id, email?, phone?` | `auth.admin.updateUserById(user_id, { email, email_confirm: true, phone, phone_confirm: true })` |
| `reset_password` | `user_id` | new temporary password → `updateUserById(user_id, { password })` → returns `{ temporary_password }` |
| `set_active` | `user_id, active` | 1) `profiles.is_active` updated **with the caller's client** (RLS as admin, audited with actor); 2) `updateUserById(user_id, { ban_duration: active ? "none" : "876000h" })`. Idempotent; safe to retry if step 2 fails ("Access removed, but sign-in block failed. Try again.") |

Every request:
1. Build a client with the caller's `Authorization` header; `rpc("is_admin")` must return `true` (active admin) → else 403 "Only an active admin can do this."
2. Reject `set_active(false)` on the caller's own id (403 "You can't deactivate yourself."). Editing one's own email/mobile is allowed; own role changes are blocked in the UI and the last-admin rule is enforced by the database (DB2).
3. Validate with the same rules as the form (small `zod` schema duplicated in the function; normalise mobile to `+91XXXXXXXXXX`, lower-case email).
4. Map auth errors: duplicate email/phone → 409 with `field`.
5. Write an explicit `audit_log` row with the service client: `actor_id = caller`, `action = 'ADMIN_CREATE_USER' | 'ADMIN_UPDATE_LOGIN' | 'ADMIN_RESET_PASSWORD' | 'ADMIN_SET_ACTIVE'`, `table_name = 'auth.users'`, `record_id = user_id`, `new_data` = changed fields **without any password**. (Writes done by the service client are otherwise logged with a null actor.)
6. Temporary password: 12 characters from an unambiguous alphabet (no 0/O/1/l/I), at least one upper, one lower, one digit, displayed as `xxxx-xxxx-xxxx` (hyphens are part of the password). Never logged, never stored outside auth.

Why the sign-in block as well as `is_active`: RLS already denies all data to an inactive profile immediately, but the account could still sign in and refresh its session; the block ends that, and is the "remote sign-out" for lost field phones (M5 5.1).

---

### 2.2 Insurers

#### 2.2.1 Insurers list — `/admin/insurers` (admin)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Admin › Insurers                                            [ + Add insurer ]│
│ Insurers                                                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ [ Search name, code or domain… ]  Status [ Active ▾]  Submission [ All ▾]    │
├──────────────────────────────────────────────────────────────────────────────┤
│ Name ▲                    Code  Sender domains            TAT   Submission  Report template │
│ Demo Health Insurance     DHI   demohealth.example        10 d  Email       ✓ Uploaded       │
│ Sample General Insurance  SGI   samplegeneral.example +1  15 d  Email       ⚠ Missing        │
│ Test Life Assurance       TLA   testlife.example          21 d  Portal      ✓ Uploaded       │
└──────────────────────────────────────────────────────────────────────────────┘
```

Columns map to `insurers.name, code, sender_domains, tat_days, submission_channel, report_template_path is not null, is_active` (Inactive badge). No pagination (≈10 rows). Warnings shown in the row: "⚠ No sender domain" (emails will go to review), "⚠ Missing" template.
Empty: "No insurers yet. Add the first insurer to start receiving cases." + [ Add insurer ].

#### 2.2.2 Insurer form — `/admin/insurers/new`, `/admin/insurers/[insurerId]` (admin)

One page, sections, single [ Save insurer ] in a sticky footer (insurer edits are small and related). Template upload is separate because it is a file.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Admin › Insurers › Demo Health Insurance                    [Active]      │
│ Demo Health Insurance                         Open cases: 14  View →      │
├──────────────────────────────────────────────────────────────────────────┤
│ Basics                                                                   │
│   Name *            [ Demo Health Insurance             ]                │
│   Short code *      [ DHI   ]  2–10 capital letters or digits             │
├──────────────────────────────────────────────────────────────────────────┤
│ Incoming email                                                           │
│   Sender domains    [ demohealth.example ✕ ] [ siu.demohealth.example ✕ ]│
│                     [ type a domain and press Enter            ]         │
│                     Emails from these domains are matched to this        │
│                     insurer.                                             │
├──────────────────────────────────────────────────────────────────────────┤
│ Deadline                                                                 │
│   Turnaround (days) * [ 10 ]  Calendar days from receipt. Changing this  │
│                              applies to new cases only.                  │
├──────────────────────────────────────────────────────────────────────────┤
│ Report submission                                                        │
│   Channel *       (•) Email   ( ) Portal   ( ) Other                     │
│   Report email    [ siu@demohealth.example     ]                         │
│   Portal address  [ https://…                  ]   (shown for Portal)    │
├──────────────────────────────────────────────────────────────────────────┤
│ Report template                                                          │
│   DHI-template-20261112.docx · uploaded 12 Nov 2026  [ Download ]        │
│   [ Choose .docx file ]                            [ Upload template ]   │
├──────────────────────────────────────────────────────────────────────────┤
│ Reading instructions for incoming emails                                 │
│   Notes      [ Claim no. is in the subject after "CCN:". Hospital     ]  │
│              [ name is in the attached claim form, page 1.           ]   │
│   Other names this insurer uses for a field                              │
│   Field [ Claim number ▾]  Labels [ CCN ✕ ][ Claim Ref ✕ ]   [ Remove ]  │
│   [ + Add field ]                                                        │
├──────────────────────────────────────────────────────────────────────────┤
│ [ Deactivate insurer ]                       [ Cancel ] [ Save insurer ] │
└──────────────────────────────────────────────────────────────────────────┘
```

| Field | Control | Validation | Column |
|---|---|---|---|
| Name | text | required, 2–120, unique (`insurers_name_key`) → "An insurer with this name already exists." | `name` |
| Short code | text, auto upper-case | required, `^[A-Z0-9]{2,10}$`, unique → "This code is already used by …". Hint on edit: "Used in file names of reports and portal packs." | `code` |
| Sender domains | tag input | 0–20 entries; each normalised (trim, lower-case, strip `@` / anything before `@` with note "We kept the domain part of the email address"), valid hostname; duplicates removed; **public mail domains rejected** (gmail.com, googlemail.com, yahoo.com, yahoo.co.in, outlook.com, hotmail.com, live.com, rediffmail.com, icloud.com): "Public email domains can't identify an insurer. Emails from these senders go to the review queue."; not used by another insurer (DB) → "siu.example.in is already used by Test Life Assurance." Empty list → warning only. | `sender_domains citext[]` |
| Turnaround (days) | number | required integer 1–365, default 15 | `tat_days` |
| Channel | radio | required | `submission_channel` |
| Report email | email | optional; valid email | `reply_to_email citext` |
| Portal address | url | required when Channel = Portal; must start `https://`; hidden otherwise (value kept) | `portal_url` |
| Report template | file | `.docx` only, ≤ 10 MB; uploaded to bucket `report-templates` at `{insurer_id}/{yyyyMMdd-HHmmss}-{safe-name}.docx`; previous files kept | `report_template_path` |
| Notes | textarea | ≤ 2,000 chars | `extraction_hints.notes` |
| Other names | repeatable row: field select + tag input | field from `EXTRACTION_FIELDS` (owned by M3; v1: claim number, policy number, claim type, claim amount, incident date, insured name, patient name, hospital name); ≤ 10 labels each, ≤ 60 chars | `extraction_hints.aliases.{field}: string[]` |
| Active | Deactivate/Reactivate button | — | `is_active` |

`extraction_hints` v1 shape (M3 may add keys; the editor preserves unknown keys on save):
```json
{ "notes": "Claim no. is in the subject after \"CCN:\".",
  "aliases": { "insurer_claim_no": ["CCN", "Claim Ref"], "policy_no": ["Policy Number"] } }
```

Behaviour:
- Template upload: server action → upload with the admin's session → update `report_template_path`. Toast "Template uploaded." Download uses a 60-second signed link. The template upload control is disabled on `/new` until the insurer is saved ("Save the insurer first, then upload its template.").
- Deactivate confirm: title "Deactivate Demo Health Insurance?"; body "It will no longer be offered when cases are created. Its 14 open cases continue as normal. Incoming emails from its domains are still matched but marked for review." Button **Deactivate insurer**. Insurers are never deleted (cases reference them).
- Unsaved changes: leaving the page asks "Discard unsaved changes?".
- Save errors: field-level for unique violations; otherwise "Not saved. Try again." Successful save toast: "Insurer saved."
- No delete button.

---

### 2.3 Checklist templates

How templates are used (context for the UI copy): when staff create a task (M4 4.4) they pick a checklist for the case's claim type; the list shows insurer-specific checklists first, then all-insurer ones, and an insurer-specific checklist hides an all-insurer checklist of the same name. `apply_checklist_template()` **copies** the items into the task, which staff may then edit for that case. Saving a template never changes existing tasks.

#### 2.3.1 Checklists list — `/admin/checklists` (admin)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Admin › Checklists                                        [ + New checklist ]│
│ Checklists                                                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Claim type [ All ▾]   Insurer [ All ▾]   Status [ In use ▾]                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ HEALTH                                                                       │
│ Name                       Applies to              Items        Ver  Saved   │
│ Hospital visit             All insurers            6 · 4 req.   3    12 Nov  │
│ Hospital visit             Demo Health Insurance   8 · 6 req.   1    12 Nov  │
│                            ↳ overrides "All insurers" for this insurer       │
│ Insured residence visit    All insurers            5 · 3 req.   1    12 Nov  │
│ MOTOR                                                                        │
│ Garage and spot visit      All insurers            4 · 3 req.   2    11 Nov  │
│ DEATH                                                                        │
│ (no checklist in use)  [ Create one ]                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Grouped by `claim_type` in enum order (Health, Motor, Death, Personal accident, Property, Other); every group shown, empty groups show "(no checklist in use)" so gaps are visible.
- Columns: `checklist_templates.name`; `insurer_id` → "All insurers" or insurer name; item count and mandatory count from `checklist_template_items`; `version`; `updated_at`; status badge "In use" (`is_active`) / "Not in use".
- Filters: claim type; insurer (All, "All insurers only", each insurer); status (In use — default, Not in use, All).
- Row actions (in the editor, not the list): Duplicate, Put in use / Take out of use.

#### 2.3.2 Checklist editor — `/admin/checklists/new`, `/admin/checklists/[templateId]` (admin)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Admin › Checklists › Hospital visit (Demo Health Insurance)     [In use] Version 3   │
│ ┌─ ⓘ ─────────────────────────────────────────────────────────────────────────────┐  │
│ │ Saving changes affects tasks created after you save. Existing tasks keep their  │  │
│ │ own copy — 7 open tasks use an earlier copy of this checklist.                  │  │
│ └─────────────────────────────────────────────────────────────────────────────────┘  │
├───────────────────────────────────────────────────────────┬──────────────────────────┤
│ Name *        [ Hospital visit                  ]         │ Preview (field app)      │
│ Claim type *  [ Health ▾]                                 │ ┌──────────────────────┐ │
│ Applies to *  [ Demo Health Insurance ▾]                  │ │ Hospital visit       │ │
│                                                           │ │ 0 of 6 required done │ │
│ Items                                                     │ │──────────────────────│ │
│ #  Description                 Type       Req. Camera     │ │ 1 Hospital front …   │ │
│ 1 [Hospital front with sign ] [Photo ▾]   [x]  [x]  ↑ ↓ ✕ │ │   Photo · Required · │ │
│ 2 [Indoor case papers / IPD ] [Photo ▾]   [x]  [x]  ↑ ↓ ✕ │ │   Camera only        │ │
│ 3 [Final bill and discharge ] [Document▾] [x]  [ ]  ↑ ↓ ✕ │ │ 2 Indoor case …      │ │
│ 4 [Statement of insured     ] [Audio ▾]   [ ]  [ ]  ↑ ↓ ✕ │ │   Photo · Required · │ │
│ 5 [Field notes              ] [Note ▾]    [ ]  [–]  ↑ ↓ ✕ │ │   Camera only        │ │
│ [ + Add item ]                                            │ │ …                    │ │
│                                                           │ └──────────────────────┘ │
├───────────────────────────────────────────────────────────┴──────────────────────────┤
│ ● Unsaved changes   [ Duplicate ] [ Take out of use ]   [ Discard changes ] [ Save checklist ] │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| Field | Control | Validation | Column |
|---|---|---|---|
| Name | text | required, 3–80; unique among in-use checklists with the same claim type and insurer scope | `checklist_templates.name` |
| Claim type | select | required, `claim_type` enum | `claim_type` |
| Applies to | select: "All insurers" + active insurers | — | `insurer_id` (null = all) |
| Item description | text | required, 3–200 chars | `checklist_template_items.description` |
| Type | select: Photo, Document, Audio, Video, Note | required | `required_evidence_type` |
| Required | checkbox (default on) | — | `is_mandatory` |
| Camera only | checkbox (default on for Photo, off otherwise); disabled and cleared for Note | — | `camera_only` |
| Order | ↑ / ↓ buttons; Alt+↑ / Alt+↓ on a focused row | 1–50 items | `position` (rewritten 1..n on save) |

Behaviour:
- Item edits are local until **Save checklist**, which calls `save_checklist_template(id, expected_version, name, claim_type, insurer_id, items)` — one transaction: updates the header, updates/inserts/deletes items, renumbers positions, increments `version`. If another admin saved in between: "This checklist was changed by someone else. Reload to see their changes." (version mismatch).
- Header tooltips: Required — "The field operator cannot complete the task until this item is captured or marked not available." Camera only — "The field app will not allow picking from the gallery. Gallery uploads that slip through are flagged for review."
- Delete item (✕): no dialog; item is removed with an inline "Item removed. [Undo]" until save. Existing tasks keep their copy.
- Warnings (non-blocking, above Save): "No item is required." / "Two items have the same description."
- New checklist: created **not in use**; after the first save the page offers [ Put in use ].
- **Put in use** confirm: "Put "Hospital visit" in use for Demo Health Insurance? It replaces the checklist currently in use with the same name for Health · Demo Health Insurance (version 2). Tasks already created are not affected." Button **Put in use**. Calls `activate_checklist_template(id)` (deactivates the one it replaces in the same transaction).
- **Take out of use** confirm: "Staff will no longer be able to choose this checklist for new tasks. Existing tasks are not affected." Button **Take out of use**.
- **Duplicate** → `/admin/checklists/new?copy=[id]`, pre-filled "Copy of …", not in use. This is how an insurer override is made: duplicate the all-insurer checklist, choose the insurer, adjust, put in use.
- No delete for checklists (history of what was used stays meaningful); "Not in use" is the archive.
- Leaving with unsaved changes asks "Discard unsaved changes?".
- Preview panel: 360 px wide, mimics the field-app task screen (title, "0 of N required done", numbered items with type label and "Required" / "Camera only" chips). Updates live. Footnote: "Approximate — the field app layout may differ slightly." Below 1280 px width the preview moves under the item list.
- Empty items: "Add the first item the field operator should capture." + [ + Add item ].
- Toast on save: "Checklist saved (version 4)."

### 2.4 Seed data — recommendation

**Enter the 10 insurers, the agreed checklists and the staff list through the admin screens, in one 2-hour joint session with the client admin** (end of week 2, after M0 0.2/0.3 sign-off).

| Option | Verdict |
|---|---|
| Admin UI (recommended) | ≈10 insurers × 3 min + ≈8 checklists × 8 min + ≈15 users × 1 min ≈ 1.5–2 h. Doubles as the M2 exit test ("admin configures an insurer and checklist without developer help") and as admin training. Every row is audited with the real actor. No client data in git. |
| SQL seed / migration | Fast and repeatable, but puts client data in the repository, bypasses the UI validation and audit actor, and does not prove the exit criterion. Kept for **local dev only** (`supabase/seed.sql`, fake data). |
| CSV import | Extra screen and parsing to build for ~25 rows, used once. Not built. |

Preparation (M0 deliverable): one spreadsheet with three tabs the developer sends to the client —
- *Insurers*: name, short code, sender domains, turnaround days, channel, report email, portal address, report template file, notes on email layout.
- *Checklists*: claim type, checklist name, insurer (or "all"), item description, type, required (Y/N), camera only (Y/N), order.
- *Staff*: full name, role, region, mobile, email.

Order on the day: users (admins first) → insurers → templates uploaded → checklists (all-insurer ones, then duplicates for insurer overrides) → put in use → spot-check one checklist preview with an operator.

### 2.6 Availability and assignment rules (build-plan piece 2.6) — reviewed 2026-11-14 (D40)

> **User answer (D40):** default assignment is by case (claim) type, set up in advance as rules; the orchestrator can reassign any case to someone else. The rules screen below is how those defaults are defined; reassignment is piece 4.2.

Admin only (decision 2026-11-14). Note: the database also lets orchestrators write `assignment_rules` / `assignment_rule_members` (policies `p_rules_write`, `p_rule_members_write`) and change anyone's availability (`set_availability`); the screens are nonetheless admin-only, so these are a wider permission than the UI uses. Both screens sit under a new `Assignment` item in the Admin group.

Behaviour they configure (from `20261113000100_revised_flow.sql`, no change proposed): `private.pick_office_assignee()` walks active rules (most specific first: insurer set, then claim type set, then `priority`, then `name`), takes the first assignable member of the first rule that has one (`least_loaded` = fewest open cases, `round_robin` = longest since last assignment), and falls back to every assignable `office` user, least loaded. Assignable (`private.is_assignable()`) = active, role office/orchestrator/admin, `availability = 'available'` or `availability_until` already passed, and open cases below `max_open_cases` (null = no cap). If nobody is assignable, orchestrators are notified (`case_unassigned`) and the case waits for `retry_auto_assign()` or `assign_case`-style manual assignment.

#### 2.6.1 Staff availability — `/admin/assignment` (admin)

- **Layout**: page header "Assignment"; tabs "Availability" (this screen) and "Rules and pools". Table of active staff (office, orchestrator, admin). Columns: name, role, availability (badge), "until" date, open cases / cap, assignable now (yes/no with reason). Row action "Edit". Filters in URL params: role, availability, assignable.
- **Open cases** = count of `cases` with `office_owner_id` = user and `status` not in `submitted`, `closed`, `cancelled` (same definition as `is_assignable`). Read via `cases` (staff RLS).
- **Edit panel (per user)**:
  - Availability: select `available` / `on_leave` / `unavailable` (enum `staff_availability`). Required.
  - Until: date-time, shown only when not `available`; optional (empty = until changed by hand); must be in the future (UI check; the database does not check). Cleared automatically when set to `available`.
  - Max open cases: whole number 1-500 or empty (no cap). Matches the check on `profiles.max_open_cases`.
- **Actions**: Save availability and until -> `rpc set_availability(p_user_id, p_availability, p_until)`. Save cap -> `profiles.update({ max_open_cases })` (admin-only write on `profiles`; audited by the existing profiles trigger, to be confirmed in T-review).
- **Empty state**: "No active staff yet. Add users under Users." **Error state**: standard `ErrorState` with retry; `mapDbError` maps 42501 to "Only an admin can change this" and P0002 to "User not found".
- **RLS dependency**: `profiles` read for staff; `set_availability` is security definer and checks the caller (self, orchestrator, admin); `profiles` update is admin-only, so cap changes need the admin role.
- **Needs migration**: (1) nothing for the fields themselves; (2) a validation that `availability_until` is in the future is not enforced by the database (UI-only unless the user wants it); (3) an "assignable now" reason is not exposed by the database (`private.is_assignable` is boolean, in `private`); the screen computes the reason in the browser from the columns above, or a read function is needed (**needs migration** if the user wants it server-side).

#### 2.6.2 Rules and pools — `/admin/assignment/rules` (admin)

- **Layout**: list of rules ordered as the picker orders them (specific first, then `priority`, `name`), each row: name, insurer (or "Any"), claim type (or "Any"), strategy, priority, pool size, active toggle. Row opens the rule form (side panel or `/admin/assignment/rules/[ruleId]`; `/new` for a new rule). A fixed last row, "Fallback: all assignable office users, least loaded", explains the built-in fallback and is not editable.
- **Rule form fields**:
  - Name: required, 2-100 characters after trimming (check on `assignment_rules.name`).
  - Insurer: select of `insurers`, or "Any insurer" (null).
  - Claim type: select of enum `claim_type`, or "Any claim type" (null).
  - Strategy: `least_loaded` or `round_robin` (enum `assignment_strategy`), default `least_loaded`.
  - Priority: integer, default 100; lower runs first among equally specific rules.
  - Active: boolean (`is_active`).
  - Pool (members): multi-select of active staff (`profiles` role office/orchestrator/admin) -> `assignment_rule_members (rule_id, profile_id)`. A rule with an empty pool is allowed by the schema but never assigns; the form warns "Empty pool: this rule will be skipped".
- **Actions**: create / edit -> `assignment_rules` insert / update; pool -> insert / delete rows in `assignment_rule_members` (members are removed with the rule by cascade). Deactivate rather than delete is advised; delete allowed with confirm. Rule writes are audited (`trg_assignment_rules_audit`); no audit trigger on `assignment_rule_members` was found (needs migration if pool changes must be audited). "Preview" (optional): for a chosen insurer and claim type, list which rule would match first, computed in the browser from the rows above.
- **Validation messages**: duplicate-looking rules (same insurer, claim type, priority) are allowed by the schema; the form shows an informational note only.
- **Empty state**: "No rules. New cases go to the least-loaded available office user." with a "New rule" button. **Error state**: as 2.6.1.
- **RLS dependency**: `p_rules_read` and `p_rule_members_read` (any staff); `p_rules_write` and `p_rule_members_write` (admin, orchestrator). A pgTAP test already covering these policies should be confirmed; none is added by this design.
- **Needs migration**: (1) saving a rule and its pool atomically is not available as a function (two table writes from the browser); a `save_assignment_rule()` function would be needed if atomicity matters; (2) no unique constraint on (insurer, claim type, priority); (3) no validation that pool members are assignable roles (the picker re-checks at assignment time). Nothing else is proposed.

**Open points for review**: 2.6-O1 should orchestrators also see these screens (database permits; decision so far: admin only)? 2.6-O2 do we want the three migrations items above, or accept UI-only handling for Phase 1?

---

## 3. Shared components and style guide

Built once in `apps/web/components/ui/` during M2; M3–M8 reuse them. Server components by default; client only where interaction needs it.

| Component | Purpose / API sketch | Used by |
|---|---|---|
| `PageHeader` | breadcrumbs, `h1`, optional status badges, right-aligned actions | every screen |
| `FilterBar` | search input (debounced 300 ms) + selects; reads/writes URL params; "Clear filters"; result count | all lists |
| `DataTable` | columns config `{ key, header, cell, sortable, align, width }`; sticky header; sortable headers as buttons with `aria-sort`; first cell is a real link to the row's page; empty/loading slots | all lists |
| `Pagination` | `page`, `pageSize` (50), `total`; "1–50 of 312"; Prev/Next; URL `page` | cases, tasks, audit log, intake |
| `FormField` | label, required marker, hint, error (linked by `aria-describedby`), wraps any control | all forms |
| Controls | `TextInput`, `NumberInput`, `PhoneInput` (+91 prefix, normalises), `EmailInput`, `Select`, `RadioGroup`, `Checkbox`, `Textarea`, `TagInput` (Enter/comma to add, Backspace to remove, ✕ buttons), `FileInput` (accept, max size) | all forms |
| `SubmitButton` | shows "Saving…" and disables via form pending state | all forms |
| `ConfirmDialog` | native `<dialog>`; title, body, confirm label (verb), `tone="danger"`; Esc closes; focus returns to trigger; Cancel focused for danger | deactivate, cancel case, submit report |
| `Toaster` / `toast` | bottom-right, `aria-live="polite"`; success auto-dismiss 5 s; errors stay until closed; server actions set a short-lived flash cookie read by the Toaster after redirects | everywhere |
| `StatusBadge` | one map per enum (`case_status`, `task_status`, `checklist_status`, `extraction_status`, `email_status`, `report_status`, active/inactive, in use) → label + tone | lists, headers |
| `EmptyState` | title, one sentence, optional primary action; variant for "no results for filters" | all lists |
| `ErrorState` / `error.tsx` | "… could not be loaded." + Try again (`reset()`) | every route segment |
| `TableSkeleton` / `loading.tsx` | grey rows matching the table | every list |
| `InlineAlert` | info / warning / danger callout | checklist impact note, warnings |
| `UnsavedChangesGuard` | `beforeunload` + in-app link interception when a form is dirty | insurer, checklist, M3 review, M4 task |
| Formatters (`lib/format.ts`) | `formatDateTime` (IST, "12 Nov 2026, 14:05"), `formatRelativeDay` ("Today", "Yesterday", "2 Nov"), `formatINR` (en-IN, "₹1,85,000"), `formatPhone` ("+91 98000 00001"), `ROLE_LABELS`, enum labels | everywhere |
| Validation (`lib/validation/*.ts`) | `zod` schemas per form; `mapDbError()` turns 23505/23514/42501 into field or page messages; RLS "0 rows updated" treated as "Not saved — you may not have permission or the record changed." | all server actions |

Patterns:
- **Page layout**: `PageHeader` → `FilterBar` (lists) → content. Forms: sections with a heading and a hairline divider; sticky footer for primary actions on long forms.
- **Mutations**: forms post to server actions (`useActionState`); validation errors return to the form; success → `revalidatePath` + redirect or toast.
- **Copy**: sentence case; buttons are verb + noun ("Add user", "Save insurer"); never mention the underlying technology; errors say what happened and what to do.

### 3.1 Style guide

Define tokens with Tailwind `@theme` in `app/globals.css` (keeps the shell's existing slate/blue look).

| Token | Value | Use |
|---|---|---|
| `--color-primary` | blue-800 `#1e40af` | primary buttons, links (white text 8.6:1) |
| `--color-primary-soft` | blue-50 | active nav, selected rows |
| `--color-text` / `--color-text-muted` | slate-900 / slate-600 (`#475569`, 7.6:1 on white) | body / secondary text; never lighter than slate-600 for text |
| `--color-border` | slate-200 (`#e2e8f0`); inputs slate-400 (3:1 non-text contrast) | dividers / control borders |
| `--color-bg` / `--color-surface` | slate-50 / white | page / cards, tables |
| `--color-danger` | red-700 `#b91c1c` on white, red-50 background | destructive, errors |
| `--color-warning` | amber-800 `#92400e` text on amber-50 | warnings ("Missing", due soon) |
| `--color-success` | green-800 `#166534` on green-50 | success, "Active", submitted |
| Focus ring | 2 px blue-700 outline, 2 px offset (as in `nav-links.tsx`) | every focusable element |

- **Type scale** (system font stack): 12 px (labels in tables, badges), **14 px base for tables and forms** (dense), 16 px body text, 20 px section headings, 24 px page title. Line height 1.4 for 14 px. Tabular numerals in tables.
- **Spacing**: 4 px grid. Table row 40 px (cell padding 8 × 12); controls 36 px tall; form field gap 16 px; section gap 24 px; page padding 24–32 px (existing).
- **Badges**: 12 px medium text, 2 × 8 px padding, rounded; colour + text (never colour alone).
- **Accessibility**: WCAG 2.1 AA. Every control has a visible label; required fields marked "*" with "required" in the accessible name; errors announced (`aria-invalid`, `aria-describedby`, focus moves to the first invalid field on submit); full keyboard use (Tab order follows layout, Enter submits, Esc closes dialogs, Alt+↑/↓ reorders checklist items); no drag-only interactions; skip link; `aria-current="page"` in nav (exists); tables use `<th scope>`; minimum click target 32 px.
- **Desktop first**: designed for 1366 × 768 and up; usable down to 1024 px; below `md` the sidebar stacks (existing).

---

## 4. Data access per screen

Legend: **RLS** = direct table/RPC call with the user's session from a server component or server action; **SA** = Next.js server action; **FN** = `admin-users` function.

| Screen | Reads | Writes |
|---|---|---|
| Users list | RLS: `rpc('admin_list_users')` (profiles + email, phone, last sign-in, blocked); RLS: `tasks.select('assignee_id').in('status', ['pending','in_progress'])` → counts | — |
| Add user | RLS: distinct regions from `profiles` | SA → FN `create` |
| User detail | RLS: `rpc('admin_list_users', { p_user_id })`; open-task count | SA → RLS `profiles.update({ full_name, role, region }).eq('id').select()`; SA → FN `update_login`, `reset_password`, `set_active` |
| My account | own profile (existing `getCurrentProfile`) | SA → `auth.updateUser({ password })` (own session) |
| Insurers list | RLS: `insurers.select(...)` | — |
| Insurer form | RLS: `insurers` by id; RLS: `cases` count (`head: true`) where insurer and status not in submitted/closed/cancelled; signed URL from `report-templates` | SA → RLS `insurers.insert/update`; SA → Storage upload to `report-templates` + `insurers.update({ report_template_path })` |
| Checklists list | RLS: `checklist_templates.select('*, insurers(name), checklist_template_items(is_mandatory)')` | — |
| Checklist editor | RLS: template + items ordered by `position`; active insurers; open-task count: `task_checklist_items` joined to `tasks` (open) where `source_template_item_id` in template's items → distinct `task_id` | SA → RLS `rpc('save_checklist_template', …)`; SA → RLS `rpc('activate_checklist_template', { p_id })`; SA → RLS `checklist_templates.update({ is_active: false })`; duplicate = insert template + items (RPC with null id) |

### 4.1 Database changes needed (one new migration, e.g. `20261112000000_m2_admin.sql`, plus `supabase/tests/06_m2_admin.test.sql`)

| # | Change | Why |
|---|---|---|
| DB1 | `public.admin_list_users(p_user_id uuid default null)` — `security definer`, `set search_path = ''`, raises 42501 unless `public.is_admin()`; returns profile columns + `auth.users.email, phone, last_sign_in_at, banned_until`. Revoke from `anon`, grant `authenticated`. | Email, mobile and last sign-in live in `auth.users`, which the API cannot read. Avoids copying them into `profiles` (and avoids an audit row on every sign-in). |
| DB2 | Trigger on `profiles` (before update/delete): reject any change that leaves **zero active admins** ("There must be at least one active admin", errcode 42501). | Prevents locking everyone out. |
| DB3 | `insurers`: check `code ~ '^[A-Z0-9]{2,10}$'`; check `tat_days <= 365`; before insert/update trigger normalising `sender_domains` (trim, lower-case, de-duplicate, sort) and rejecting a domain already used by another insurer (errcode 23505, message names the insurer). | Domain overlap would make insurer identification (M3 3.3) ambiguous; no array-overlap unique constraint exists. |
| DB4 | Storage bucket `report-templates` (private, `.docx` MIME only, 10 MiB): select for `is_staff()`, insert/update for `is_admin()`, no delete. | Templates must not be writable by office staff (the `reports` bucket is staff-writable). M6 6.4 reads from here. |
| DB5 | `checklist_templates.version int not null default 1`. | Display and optimistic concurrency. |
| DB6 | `task_checklist_items.source_template_item_id` FK → `on delete set null`. | Today, deleting a template item that any task copied fails with an FK error. |
| DB7 | Checks on `checklist_template_items`: `char_length(btrim(description)) between 3 and 200`; `not (camera_only and required_evidence_type = 'note')`. | Mirrors form rules. |
| DB8 | Replace `uq_active_template` with a unique index on `(claim_type, coalesce(insurer_id, '0…0'), lower(name)) where is_active`. **Conditional on M0 0.3** (default: do it). | Allows several checklists per claim type (K7). |
| DB9 | `public.save_checklist_template(p_template_id uuid, p_expected_version int, p_name text, p_claim_type claim_type, p_insurer_id uuid, p_items jsonb) returns table(id uuid, version int)` — `security invoker` (RLS: admin writes only), `set search_path = ''`. Null id = create (not in use). Deletes removed items, updates kept ones by id, inserts new ones, renumbers positions (move to temporary offset first to respect `unique (template_id, position)`), bumps `version`; raises 40001 on version mismatch; requires 1–50 items. | Reorder/delete cannot be done safely as separate client calls. |
| DB10 | `public.activate_checklist_template(p_id uuid)` — `security invoker`; deactivates the in-use template with the same claim type, insurer scope and name, then activates `p_id`, in one transaction. | Swap without hitting the unique index. |
| DB11 | Add `checklist_templates` and `checklist_template_items` to the `private.audit_row()` triggers. | Changes to what field operators must capture should be traceable. |
| DB12 | `supabase/config.toml`: `[functions.admin-users] verify_jwt = true`; function secret `FIELD_SIGN_IN`. | K2, K4. |

pgTAP tests (DB1–DB11): non-admin staff and field get 42501 from `admin_list_users`; last-admin deactivation and demotion rejected, second admin allowed; domain normalised and cross-insurer duplicate rejected; office cannot write `report-templates`, can read; deleting a template item used by a task sets the link to null; save RPC renumbers, rejects stale version, rejected for orchestrator (RLS); activate swaps atomically; audit rows written for template saves.

---

## 5. Implementation breakdown (ordered)

Each task is one branch/PR, verifiable on its own. Reference piece IDs in commits (`2.1`, `2.2`, …). Test tools: pgTAP for the database, Vitest for `lib/` (formatters, validation), Deno test for the function's validation, plus the manual checks listed. Browser end-to-end tests are deferred to M10.

| # | Task | Acceptance criteria | Test notes |
|---|---|---|---|
| T1 | **Migration DB1–DB11** + `06_m2_admin.test.sql`; regenerate `lib/database.types.ts` | `db reset` and `test db` pass; advisors show no new errors (security-definer warning on `admin_list_users` accepted and noted in `supabase/README.md`) | Every bullet in §4.1 test list has a pgTAP assertion |
| T2 | **UI foundation**: tokens in `globals.css`; `PageHeader`, `FormField` + controls, `SubmitButton`, `ConfirmDialog`, `Toaster` + flash cookie, `StatusBadge`, `EmptyState`, `ErrorState`, `InlineAlert`; `lib/format.ts`; `lib/validation/db-errors.ts`; add `zod`, `vitest` | Components render on a dev-only page `app/(app)/dev/ui/page.tsx` (404 in production); keyboard: dialog traps focus, Esc closes, focus returns | Vitest for formatters (IST, INR, phone) and `mapDbError`; manual keyboard pass; contrast check of badge tones |
| T3 | **DataTable, FilterBar, Pagination** with URL-param state | Sorting/filtering survive reload and back button; `aria-sort` set; first cell is a link | Exercised by T5 and T9; Vitest for URL-param helpers |
| T4 | **Shell changes** (§1.4) | Admin sees all items incl. Admin group with Audit log at `/admin/audit-log`; orchestrator/office see no Admin group; `/admin/*` as office → `/forbidden`; skip link works; "My account" link present | Sign in as each seeded role; old `/audit-log` route removed |
| T5 | **`admin-users` function** (`create`, `update_login`, `reset_password`, `set_active`) + `lib/admin-users.ts` server-side wrapper | Non-admin JWT → 403; no JWT → 401; create makes an active profile with the right role/region; duplicate mobile → 409 with `field: "phone"`; deactivated user cannot sign in and gets no data; reactivation restores sign-in; self-deactivation → 403; audit row per action without password | Deno tests for validation/normalisation; scripted calls against the local stack with seeded admin and office tokens |
| T6 | **Spike: field sign-in method** — confirm mobile + password sign-in on the hosted dev project without an SMS provider | Written result added to `07-decisions…` (new decision); `FIELD_SIGN_IN` set accordingly | Sign in a test field user from a script on the hosted project |
| T7 | **Users list** `/admin/users` | Columns and filters per §2.1.1; inactive users hidden by default; empty/loading/error states; search matches mobile with or without spaces | Seed data: 5 users; check filters via URL |
| T8 | **Add user** `/admin/users/new` | Requirements switch with role and `FIELD_SIGN_IN`; temporary password dialog shown once; duplicate errors at the field; new staff user can sign in to the web app with the temporary password; new field user appears with region | Manual: create one of each role locally |
| T9 | **User detail**: profile save, sign-in details, reset password, deactivate/reactivate, role-change warnings, own-account restrictions | All confirmations per §2.1.3; last-admin message surfaces from DB; audit log shows the admin as actor for profile edits | Manual + check `audit_log` rows |
| T10 | **My account** `/account` | Password rules enforced with clear messages; user can sign in with the new password | Manual |
| T11 | **Insurers list + form** (without template) | Create/edit with all validations in §2.2.2; domain tag input normalises pasted email addresses; public domains rejected; cross-insurer duplicate message names the insurer; portal address required only for Portal; unknown `extraction_hints` keys preserved; deactivate confirm shows open-case count | Vitest for domain normalisation; manual with seeded insurers |
| T12 | **Report template upload/download** | `.docx` ≤ 10 MB only; new upload keeps old file and updates the path; download via short signed link; office user cannot upload (RLS) | Manual; try a `.pdf` and an 11 MB file |
| T13 | **Checklists list** | Grouping by claim type with empty groups; override hint row; filters | Seeded templates |
| T14 | **Checklist editor**: header fields, item rows, add/reorder (buttons + Alt+↑/↓)/remove with undo, save RPC, version conflict message, impact note with open-task count, unsaved-changes guard | Saving never changes existing `task_checklist_items` (verify the seeded task's items after editing its template); camera-only disabled for Note | Manual + SQL check of seeded task items before/after |
| T15 | **Preview, Duplicate, Put in use / Take out of use** | Preview updates live; duplicate creates "Copy of …" not in use; putting an override in use replaces only the same-name checklist in the same scope, and case templates linked to the replaced checklist are re-pointed to the new one in the same transaction (audited), so new cases get the new items at once (D42); names 3–80 characters | Manual: create a DHI override of "Health claim — hospital visit" |
| T16 | **Master data session** (2.4) with the client admin; record M2 exit | Admin, unaided, adds one new insurer and its checklist; all 10 insurers, checklists and staff entered; spreadsheet archived outside git | Exit criterion of M2 in `04-build-plan.md` |

Estimate: T1–T4 ≈ 1 day, T5–T10 ≈ 1 day, T11–T15 ≈ 1 day, T16 ≈ 0.25 day (fits M2's 3 days plus the session). T2/T3 are an investment that M3–M8 draw on.

---

## 6. Open questions

| # | Question | Owner | Default if no answer |
|---|---|---|---|
| O1 | Field sign-in: mobile + password (free), mobile OTP (needs a paid SMS provider), or email + password? Do operators have personal email addresses? | Client / developer (T6) | Mobile + password |
| O2 | Is the client admin also the orchestrator day to day (one person, one account)? | Client | Yes — admin sees all screens (K1) |
| O3 | Fixed list of field regions (cities/districts)? | Client | Free text with suggestions **Resolved 2026-11-14: free text with suggestions.** |
| O4 | Is turnaround in calendar or working days, and does any insurer have different turnaround per claim type? (Q7) | Client | Calendar days, one value per insurer |
| O5 | Do any insurers or their third-party administrators send from public mail addresses (e.g. gmail.com) or from a domain shared by several insurers? If yes, M3 needs sender **address** matching (schema change). | Client | No |
| O6 | Several checklists per claim type (by visit type) — confirm with the M0 checklists (K7 / DB8). | Client (M0 0.3) | Yes |
| O7 | Do checklist items need a separate guidance text for operators (beyond the 200-character description)? | Orchestrator | No; description only |
| O8 | One report template per insurer, or per insurer and claim type? (`report_template_path` is per insurer.) | Client (M0 0.2) | Per insurer |
| O9 | Must users be forced to change a temporary password at first sign-in? (Adds a flag and a forced screen in web and field app.) | Client | No; advised verbally, `/account` available **Resolved 2026-11-14: no forced password change.** |
| O10 | Should orchestrators get read-only access to the Insurers screen (e.g. to look up a portal address)? | Client | No; shown in context on the case (M7) **Resolved 2026-11-14: no; orchestrators get no insurer screens.** |
