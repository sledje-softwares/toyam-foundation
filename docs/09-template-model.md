# 09 — Template Model (D20)

One template per **insurer × claim type × variant** drives everything a case needs:

```
case template (e.g. IGI · motor · od)
 ├─ intake_rules         how to recognise the email and read its fields
 ├─ sections[]           the report, in order
 │   ├─ fields[]         source intake (from the email) or office (filled in the workspace)
 │   └─ categories[]     evidence categories whose images appear beside this section
 ├─ checklists[]         default field checklist (items carry categories)
 └─ output               requires_approval, output_formats, default_output_format,
                         docx_template_path, report_email
```

The same `evidence_categories` codes are used by the field checklist (pinned in the thread), the labelling pipeline (its target labels) and the report sections (its image panel). A photo labelled `dl_document` therefore ticks "DL" on the operator's checklist **and** appears beside the "Driver details" section.

## Files

| File | Purpose |
|---|---|
| `config/templates/_categories.yaml` | All evidence categories with file-name and text patterns |
| `config/templates/<insurer>-<claim>-<variant>.yaml` | One template, e.g. `igi-motor-od.yaml`, `icl-motor-od.yaml` |

Both drafts were written from the real sample emails and reports (IndusInd/Reliance OD, ICICI Lombard OD) and load cleanly: IGI 15 sections / 92 fields (21 from intake), ICICI 11 sections / 72 fields (16 from intake). The subject patterns match the real subjects, and all 11 sample ICICI attachment names are labelled correctly by file-name rules alone.

## Template YAML reference

```yaml
insurer_code: IGI                 # insurers.code
claim_type: motor                 # claim_type enum
variant: od                       # lower-case key; od, theft, cashless, reimbursement, death ...
name: IndusInd (Reliance) — Motor OD investigation
requires_approval: true           # D23
output_formats: [pdf, docx]       # allowed at send time (D22)
default_output_format: pdf
docx_template_path: report-templates/igi-motor-od.docx

intake_rules:
  sender_domains: [indusindinsurance.com]
  subject_pattern: '<regex>'      # case-insensitive; capture groups named in subject_groups
  subject_groups: {variant: 1, insurer_claim_no: 2, insured_name: 3}
  table_parser: label_value_two_column
  investigation_points: {starts_after: 'following points', until: 'Claim Intimation Details'}
  attachments_as_evidence: true

report_email:
  reply_on_thread: true
  cc_from_original: true
  subject: 'Re: {{original_subject}}'
  attachment_name: '{{insurer_claim_no}}_{{insured_name}}_IR'

checklists:
  - {name: Motor OD — garage and spot visit, default: true}

sections:
  - key: driver                   # unique in the template
    title: Driver details
    guidance: optional help shown in the workspace
    categories: [dl_document]
    fields:
      - key: driver_name          # unique in the template (not only in the section)
        label: Driver name
        type: text                # text | long_text | number | currency | date | datetime | choice | multi_choice | boolean
        source: intake            # intake (filled from the email) | office (default)
        required: true
        options: []               # for choice / multi_choice
        extract: {labels: [Name], within: Driver Details}   # intake parser hints
        help: optional help text
```

`extract` keys used by the intake parser (M3 3.5): `labels` (one or more label texts from the email table, joined in order), `within` (the block heading under which the label appears), `regex` (optional pattern with one capture group).

## Loading

```
YAML  ──(loader script, M2 2.5)──►  JSON  ──►  public.load_evidence_categories(json)
                                         └──►  public.load_case_template(json, 'config/templates/x.yaml', true)
```

- Admin (or service role) only. Unknown category codes and unknown insurer codes are rejected.
- The SHA-256 of the JSON is stored; loading identical config is a no-op. Any change creates a new version and (with `activate = true`) makes it the active one.
- Cases keep the template version they started with, so editing a template never changes a report in progress.
- Categories are upserted by `code`; never rename a `code` once used.

## Checklist and investigation points

- The template's default checklist is copied onto each field task (`create_field_task(..., checklist_template_id)`), editable per case.
- The insurer's numbered points ("RCU trigger", "Red flag case") are stored in the intake field `investigation_points`; the workspace can turn selected points into extra checklist items for the operator.

## Adding an insurer

1. Collect 20–30 emails (incl. follow-ups) and 2–3 completed reports (M0).
2. Add missing categories to `_categories.yaml` (with file-name / text patterns seen in the samples).
3. Copy the closest template, adjust `intake_rules` against real subjects, then sections and fields against the report layout.
4. Load on the local stack; run the intake parser on the samples; fix until required fields fill without review.
5. Upload the insurer's Word layout to `report-templates` and set `docx_template_path`.
