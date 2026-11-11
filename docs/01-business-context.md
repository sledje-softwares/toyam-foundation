# 01 — Business Context

## The client

An investigation firm that examines doubtful insurance claims on behalf of insurance companies. It operates with two teams:

- **Office team** — reviews collected information and prepares investigation reports.
- **Ground (field) staff** — visit sites and collect on-ground information: photographs, documents and statements.

An **orchestrator** assigns work, reviews reports and decides whether further investigation is required.

## Current process

1. **Case receipt** — Insurers send case details by email to a shared Gmail inbox. Each insurer uses its own format (email body, PDFs, scans).
2. **Data entry** — Case details are copied manually. No structured forms are in use; work is largely done in MS Word.
3. **Assignment** — The orchestrator assigns the case to a field operator based on the case and the nature of the doubt.
4. **Field collection** — The operator collects images and documents and sends everything to the office over WhatsApp.
5. **Report preparation** — Office staff sift through the WhatsApp content, identify relevant information and write the report.
6. **Review** — The orchestrator reviews the report. If more information is needed, further investigation is requested and the report is updated.
7. **Submission** — The report is submitted to the insurer, usually by email; one insurer requires portal submission. Some insurers prescribe a specific report format.

The process is highly dynamic: the investigation path varies by claim type, by the doubt raised and by what is found on the ground.

## Operating volumes (confirmed)

| Parameter | Value |
|---|---|
| Insurers | 10 |
| Cases per month | ~300 (~14 per working day, ~30 per insurer) |
| Field operators | 10 |
| Field throughput | ~1 case per operator per day |
| Field staff language | Comfortable in English |
| Email | Gmail, single shared inbox |
| Report submission | Mostly email; insurer-specific formats; one insurer via portal |

## Pain points

| Area | Problem |
|---|---|
| Intake | Manual copy-paste; errors; duplicates from reminders and resends |
| Assignment | No visibility of workload or progress; coordination by phone |
| Field evidence | WhatsApp mixes cases, compresses images, carries no case linkage, and leaves sensitive data on personal phones |
| Evidence integrity | No reliable proof of where and when evidence was captured |
| Reporting | Manual search through chats; reports written from scratch in Word |
| Review loops | Re-investigation requests are informal and untracked |
| Turnaround | No tracking of insurer deadlines or time spent per stage |

## Where the delay actually is

With ~1 case per operator per day, field work is dominated by travel and on-site time rather than evidence capture. The principal delays are in the **hand-offs**: email → data entry, field → office (WhatsApp), office → report, and the review/re-investigation loop. Phase 1 targets these hand-offs.
