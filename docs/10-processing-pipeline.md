# 10 — Processing Pipeline (D21, D30, D34, D35, D37, D38)

Every file that reaches a case (field thread, staff upload, insurer attachment) is read and labelled so that the report workspace can place it beside the right section and offer its text for tap-to-fill. The developer optimises the implementation; this document fixes the **contract** so stages can be replaced without touching the apps.

## Principle (revised 2026-11-14, D30)

One vision LLM call per image returns its **labels** (the template's own categories), the **report fields** it is evidence for (and through them and the categories, its **sections**), and a **short description only where needed** (D35). Exact, free signals (insurer file names, operator tags) are used first so the LLM is not called when the label is already known; such files get their field matches from the template's category → field map instead (gap 26, "Field matches from the template map"). Values are not read by the LLM; OCR + rules read them. Latency matters: a label within seconds lets the operator's pinned checklist tick itself on site.

Volume (revised 2026-11-14): 250–300 files per case × ~300 cases ≈ 75–90k a month.

## Models and order (D34)

1. **Label first, each image on its own, at low resolution** (~384 px long edge). At small-model prices a single low-resolution image costs a fraction of a paisa; labelling all 90k images costs ≈ $7 a month on Haiku 5.5 with the prompt cached. **Numbered 6×6 collages are tested as a bake-off arm (D36)** and adopted only if they meet the same pass marks; even then, files an operator is waiting on go singly.
2. **OCR only where it is needed**, after the label (`ocr_wanted()`). Device OCR (ML Kit) sent with the file is used first; server OCR is a dedicated OCR model (PaddleOCR family) on the fixed-cost CPU worker. Dedicated OCR models read documents better than general vision models and invent fewer characters.
3. **Numbers come from OCR + rules; the vision model is a second opinion** (below).
4. **Escalate uncertain labels (D37)**: below the confidence threshold chosen in the bake-off, the image goes immediately to Claude Sonnet 5.5 on the standard API, at the same ~384 px, under a new `pipeline_version`; the Sonnet label replaces Haiku's (Haiku's row is deactivated, kept) (expected ~10 % of images). No Batch API: labels must arrive within seconds.
5. ~~Embedding classifier later~~ — not planned (D35): every image needs the LLM call for its field matches anyway.

The model is chosen by the bake-off (`services/labeller/README.md`) on real cases labelled by the office; whether images may go to an external provider is the client's decision (Q21). Every label stores its `model`; the provider sits behind one adapter (`services/labeller/src/providers.ts`) so it can be swapped.

## Earlier principle: cheapest first

| Need | Order of attempts | Cost |
|---|---|---|
| Text | PDF text layer → on-device OCR (sent with the file) → server OCR (dedicated OCR model) **only where `ocr_wanted()`** | Free → free → fixed |
| Label | Operator tag / file-name rules (exact, free) → **small vision model** on a ~384 px image, constrained to the template's categories + short description + `needs_detail` (D30, D34) → larger model / higher resolution when confidence is low | Free → ≈ $0.0001 per image |
| Field matching | **The same LLM call** returns the fields the image is evidence for → `evidence_field_matches` (D35); files labelled without the LLM get their matches from the **template's category → field map** (below); sections = sections of those fields + sections whose categories include the label | Included in the label call / free |
| Field values | Pattern rules on OCR text (dates, amounts, DL / RC / policy / chassis numbers) → LLM only if asked | Free |

A stage records what it did; the next one decides whether more work is needed (e.g. skip server OCR when device OCR confidence is high, skip the model when a rule already labelled the file).

## Stages (run order `private.stage_rank()`: text_extract → label → ocr → field_suggest)

| Stage | Input | Output | Default for |
|---|---|---|---|
| `text_extract` | Document file | `evidence_ocr` (engine `pdf_text_layer`), or `skipped` | documents |
| `label` | File name, PDF text, image at ~384 px, the case template's categories and fields | `evidence_labels` (category, confidence, source `llm` / `filename_rule` / `operator`, pipeline_version, **description** (only where needed), **needs_detail**, **detail_reason**, **model**) and `evidence_field_matches` (field, confidence, model) | all except notes |
| `ocr` | Photo / scanned page | `evidence_ocr` per page (engine name + version, text, blocks); `skipped` when `ocr_wanted()` is false or device OCR is good enough | photos, documents |
| `field_suggest` | OCR blocks + the matched fields' pattern rules | `field_suggestions` (field, value, confidence, block index) — values for the fields the label stage matched | photos, documents |

Jobs are created automatically when evidence is inserted (`trg_evidence_enqueue`). A stage becomes claimable once earlier stages (by rank) of the same file and pipeline version are no longer queued or running; a permanently failed stage does not block later ones. The enum keeps its original order (Postgres cannot reorder an enum); only the rank decides.

## Labeller contract (D34)

- **Request:** one image, resized to ~384 px on the long edge (JPEG), plus the system prompt built per template version (`buildSystemPrompt(categories, template)`: categories with their `description`, then the template's fields grouped by section, ≈ 2,200 tokens). **The system prompt must be cached** (it is ~90 % of the input); send a case's images close together so the cache stays warm.
- **Answer:** `{"labels":[{"code","confidence"}], "fields":[{"key","confidence"}], "needs_detail", "detail_reason", "description"}`, parsed by `parseLabelAnswer()`: unknown codes and field keys dropped, at most 3 labels and 5 fields, best first; a missing `needs_detail` counts as true (an extra OCR run is cheaper than a missed number). `description` is `null` unless it adds something (damage and where, a scene, a person, an uncertain or "other" image). The model never returns values, never copies personal numbers and never judges the claim.
- **Stored:** one `evidence_labels` row per label (source `llm`), with `needs_detail`, `detail_reason`, `description` and `model` (`provider/model-id`); one `evidence_field_matches` row per matched field (`score` = the model's confidence). Sections are derived (`sectionsFor()`), not stored.
- **Escalation (D37):** when the top confidence is below the bake-off threshold, label again immediately with Claude Sonnet 5.5 on the standard API, at the same ~384 px, under a new `pipeline_version`; the Sonnet label replaces Haiku's (Haiku's row deactivated, kept). No Batch API.

## Worker (D38)

One always-on container (Mumbai region, Dockerfile, provider-neutral) runs `services/pipeline`: job polling, `label` (Node, reuses `services/labeller/src`), `ocr` (PaddleOCR, Python) and the field-value rules. The service-role key stays server-side.

**What exists (2026-11-19, `services/pipeline`, run / env / deploy in its README; not deployed):**

- **Loop** (`src/worker.ts`): `claim_processing_jobs` for the enabled stages up to `PIPELINE_CONCURRENCY`, idle and error back-off (`POLL_MS` → `POLL_MAX_MS`), `complete_processing_job` with a short machine-readable reason in `last_error` (also for `skipped`), stale `running` jobs handed back (this worker's own at start, others after `STALE_MINUTES`), SIGTERM drain with a grace period, then abort and hand back. Health `GET /healthz`. JSON logs with ids, counts and durations only.
- **`text_extract`**: pdf.js text layer → `evidence_ocr` (engine `pdf_text_layer`, blocks in page points, top-left origin), one row per page with text; `skipped` / `no_text_layer` for scans, `not_pdf` otherwise.
- **`label`**: input is the field app's 384 px copy (`evidence_derivatives`, hash-checked); without one the original is fetched, hash-checked and shrunk with sharp (EXIF and GPS dropped); a PDF with a text layer is labelled from its text (same cached system prompt, text in the user turn), a scan from page 1 rendered at 384 px. **OCR text the file already has** (device OCR first, else server OCR or the text layer) goes after the image as an excerpt (`LABEL_OCR_EXCERPT_CHARS`, default 600; whatever exists when the job runs — device OCR arriving later is not waited for), so a 384 px screenshot of a document is labelled correctly; Aadhaar-like 12-digit numbers are masked to their last 4 digits in every text sent (excerpt and PDF text). File names are not sent. The system prompt is built once per template version (all active categories, the template's fields by section) and cached in memory; the Anthropic adapter marks it `cache_control`. The answer goes through `parseLabelAnswer()` and is written atomically by **`record_llm_labels()`** (migration `20261119300000_pipeline_writers.sql`): earlier active `llm` labels deactivated, one row per label with `needs_detail` / `detail_reason`, `description` on the first row, `model` = `provider/model-id`; the file's **LLM** field matches replaced by the answer's (rows whose model is one of the file's LLM label models; the table has no `is_active` and readers take every row); matches from other sources, e.g. the per-template category → field map (model `category_map`, for files labelled by file name, operator or office), are never replaced, and an LLM match that collides with one is not written; stored **inactive** when the office has already set a `human` label. **Escalation (D37):** top confidence below `LABEL_ESCALATION_THRESHOLD` (default 0.7) or an unusable answer → the escalation model at once, same input, under `<version>+esc`; the first answer is stored inactive in the same transaction. If the escalation call itself fails, the first answer is kept and a `label` job for `<version>+esc` is queued (`enqueue_reprocessing`), which then uses the escalation model only. Defaults: `anthropic/claude-haiku-5-5` → `anthropic/claude-sonnet-5-5`. **Without a model key (or `LABEL_PROVIDER=off`) the worker does not claim `label` jobs**: they stay queued, and the later stages of those files wait behind them. **`manual` provider** for development (Q21 not approved): request + image / PDF text + prompt are written to a folder outside the repository and the answer is read from a JSON file (README).
- **`ocr`**: `skipped` when `ocr_wanted()` is false (`ocr_not_wanted`), when a PDF text layer exists (`pdf_text_layer`) or a current device OCR row exists (`mlkit_device`, made on the phone from the 1600 px copy, Latin + Devanagari: `device_ocr_present`) unless its mean confidence is below `OCR_DEVICE_MIN_CONFIDENCE` (default 0.5; no confidence reported counts as present). Server OCR is therefore for insurer attachments, scans and low-confidence device reads (where insurer attachments are OCR'd is still open). Pluggable engine: `none` (default) completes as `skipped` / `no_ocr_engine_configured`; `http` posts the original at full resolution to the PaddleOCR sidecar (`services/pipeline/ocr-sidecar`, contract in `src/ocr-engine.ts`) and stores one `evidence_ocr` row per page. The sidecar's HTTP contract is tested in a fake-engine mode; **PaddleOCR itself has not been run** (not installed in the development environment).
- **`field_suggest`**: rules (`src/rules.ts`) on the current OCR rows of any engine (PDF text layer, `mlkit_device`, server OCR; rows with text but no blocks are read line by line and their suggestions carry no `block_index`) for the fields the label matched (score ≥ `FIELD_MATCH_MIN_SCORE`) plus the fields of sections that list the file's active categories (so file-name-labelled insurer attachments also get suggestions): Indian registration numbers (incl. BH series), 17-character VIN (no I/O/Q), engine no. after its label, DL numbers (15-character and older formats), policy / claim numbers after their label, dates (day first, and ISO) returned as ISO `yyyy-mm-dd`, amounts after ₹ / Rs / INR, odometer readings. Dates and amounts rank by a hint on the same line (e.g. "DOB" for `driver_dob`). Written by **`record_field_suggestions()`**: pending `text_rule` suggestions of the file replaced, decided ones kept, a decided value not suggested again. `skipped` when OCR is not wanted or there is no OCR text.
- **Costs:** one `model_call` log line per call with tokens and `cost_usd`; **no cost table yet** (6.10).
- **Not built:** the vision second opinion on numbers (below); re-queuing OCR after an office label correction (above, "OCR skip rule"); audio / video labels (`skipped`).

## OCR skip rule — `ocr_wanted(evidence)`

True for documents, for files without an active label, and for files with an active label whose category has `needs_ocr` (from `ocr:` in `_categories.yaml`; documents by default; also odometer, chassis / engine, timeline and e-Challan photos) or with `needs_detail`. False for withdrawn files. An office correction to such a category makes OCR wanted again; the worker queues it with `enqueue_reprocessing()`.

## Second opinion on numbers

For identifier and amount fields (registration, chassis, engine, DL, policy and claim numbers, amounts, dates), the suggested value comes from OCR text and the field's pattern rule. When the file `needs_detail`, the vision model also reads the field at full resolution:

| OCR rule value vs. vision reading | Suggestion |
|---|---|
| Same | One suggestion, high confidence |
| Different | Both shown to the office; neither pre-selected |
| Only one of them | That value, normal confidence |
| Handwritten (no usable OCR) | Vision reading, marked for checking |

## Worker API (service role only)

```sql
-- claim up to N jobs of the given stages (FOR UPDATE SKIP LOCKED; attempts += 1)
select * from public.claim_processing_jobs(array['ocr','label']::processing_stage[], 10, 'worker-1');

-- finish: done | skipped | failed (failed re-queues with 2^attempts minutes back-off until max_attempts)
select public.complete_processing_job(:job_id, 'done');

-- re-run stages with a new pipeline version (e.g. improved labeller) — previous outputs stay
select public.enqueue_reprocessing(array[:evidence_ids], array['label']::processing_stage[], 'v2');

-- one LLM answer for a file, atomically (labels, field matches; optional superseded first answer, D37)
select public.record_llm_labels(:evidence_id, '{"pipeline_version":"v1+esc","model":"anthropic/claude-sonnet-5-5",
    "labels":[{"code":"dl_document","confidence":0.96}],"fields":[{"key":"dl_number","confidence":0.9}],
    "needs_detail":true,"detail_reason":"DL number","description":null}', :superseded_or_null);

-- replace the pending OCR-rule suggestions of a file
select public.record_field_suggestions(:evidence_id, '[{"ocr_id":"…","field_key":"dl_number","value":"MH1220110012345","confidence":0.8,"block_index":3}]');
```

Outputs are written with the service role: `evidence_ocr` rows directly, labels + field matches through `record_llm_labels()`, suggestions through `record_field_suggestions()` (both atomic and idempotent per file).

## Data shapes

`evidence_ocr.blocks` — array of `{ "text": "...", "bbox": [x, y, w, h], "conf": 0.0–1.0, "line": n }` in image pixel coordinates (page coordinates for PDFs). The workspace highlights blocks and copies `text` on tap. A new row for the same file and page supersedes the previous one (`is_current`).

`evidence_labels` — several active labels per file are allowed (a photo can show both the odometer and the chassis plate). `source` is one of `operator`, `filename_rule`, `text_rule`, `model`, `llm`, `human`.

`field_suggestions` — `field_id` refers to `case_template_fields` of the case's template version; `block_index` points into the current OCR blocks of that file.

## Rules engine (free path)

- File-name rules: `evidence_categories.filename_patterns` (case-insensitive regex). Insurer attachments are named descriptively (e.g. ICICI `Front View(1)_…`, `DRIVING LICENSE(1)_…`, `ECLAIM_MOT…`). **Applied in the database at arrival** (`20261117200000_filename_rule_labels.sql`): an AFTER INSERT trigger on `evidence` for `capture_source = 'email_attachment'` calls `private.apply_filename_labels()`, which inserts active `filename_rule` labels (confidence 0.9, one per matching category, several allowed). The name is normalised first: extension dropped, lower-cased, `(n)` counters removed, split on `_`, tokens carrying identifiers (4+ digits in a row, or 3+ digits in all: timestamps, ids, claim numbers, dates) dropped; patterns are tried against the tokens joined with `_` and with a space. Nothing matches means no label and the file goes the normal way. A human or operator label is never overridden; the call is idempotent; an invalid regex is skipped with a warning and never blocks the insert. When a file is labelled by rule its queued `label` job is set to `skipped`, so the LLM labeller never sees it; OCR still follows `ocr_wanted()`. Field-app files are not touched. `public.backfill_filename_labels(limit)` (service role) labels existing unlabelled email attachments.
- Text rules: `evidence_categories.text_patterns` against OCR text (e.g. "Registration Certificate", "First Information Report", "Discharge Summary").
- Field patterns: per field type and key (e.g. `dl_number` ~ Indian DL format, `chassis_no` ~ 17-character VIN, dates in `dd.mm.yyyy` / `dd-Mon-yyyy`).

## Field matches from the template map (`20261119500000_category_field_map.sql`, gap 26)

Each template version carries a category → field map with scores (`case_template_category_fields`, from `config/templates/maps/*.yaml`, docs/09). The database applies it to every labelled file, so a file labelled by file name, by the operator or by the office has field matches at no per-file cost:

- **When:** an AFTER trigger on `evidence_labels` (insert, and `is_active` changes) recomputes the file's map rows with `private.derive_category_field_matches(evidence)`; the trigger never fails the label write (a warning instead).
- **Rows:** one `evidence_field_matches` row per field, `model = 'category_map'`, `pipeline_version = 'map-v1'`, `category_id` = the category that gave it, `score = map score × label confidence` (confidence null → 1; e.g. a `filename_rule` DL at 0.9 × `dl_number` 0.95 = 0.855). Several labels mapping to one field keep the best. Idempotent (upsert on `(evidence_id, field_id, pipeline_version)`).
- **Which labels count:** active labels of source `operator`, `filename_rule`, `text_rule` and `human` always; labels of source `llm` / `model` **only while the file has no model-produced match** — the map is a fallback for an LLM answer with no fields. When the model's matches arrive (an insert of a non-`category_map` row, trigger `trg_field_matches_model`), the fallback rows built from LLM labels are removed; rows from non-LLM labels stay beside the model's.
- **Corrections:** `set_evidence_labels()` deactivates the old labels and adds human ones; the trigger recomputes, so map rows of removed categories are **deleted** and the new categories' rows added. Map rows are derived data (re-creatable from labels + template), not evidence, so deleting them is safe; the labels themselves stay as history. Rows written by a model are never touched by the map (a correction does not remove the LLM's own field matches; open decision: whether a human correction should also hide them).
- **No template on the case** → no map rows. Cases keep their template version, so a later map change does not alter their matches.
- **Backfill:** `public.backfill_category_field_matches(limit)` (service role) fills files labelled before the map existed (e.g. the filename-labelled ICICI attachments on hosted); call until it returns 0.
- **UI:** the report workspace shows a map-derived best match as "match 86% (from label)"; placement uses the same 0.5 threshold as model matches.

## Feedback loop

- Office corrections go through `set_evidence_labels()`: previous labels are deactivated (kept), human labels added. These rows are the evaluation and training set.
- Suggested values accepted or rejected in the workspace update `field_suggestions.status` (stamped with user and time).
- Measure per label source and category: precision against human corrections; use it to decide where a model or LLM is worth calling.

## Ticks in the field app

`v_evidence_processing.state` per file: `none` (no jobs), `pending`, `processing`, `failed`, `done`. The app shows ✓✓ when every file of the message is `done` (or `none`).

## Operating notes

- Withdrawn evidence still has jobs; workers may skip it (`skipped`).
- Keep engines and versions in `evidence_ocr.engine/engine_version` and `evidence_labels.pipeline_version` so results can be compared.
- Language: ML Kit and PaddleOCR handle printed Latin and Devanagari; handwritten registers are unreliable — the vision model's reading is offered for checking and the workspace falls back to a zoom viewer.
- Data: images go to the labelling provider only as approved by the client (Q21); the bake-off follows the same rule.
