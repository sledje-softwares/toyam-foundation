# Labeller (D30, D34, D35, D37)

Vision labelling for the processing pipeline, and the **bake-off** that chooses its model.

One call per image returns three things (D35):

1. **Labels** — the template's evidence categories, with confidence.
2. **Field matches** — the report fields the image is evidence for (at most 5); its sections follow from those fields and from the categories (`sectionsFor()`).
3. **A short description, only where needed** — damage and where it is, a scene, a person, or an uncertain / "other" image; `null` for routine documents.

It also says whether the image must be read at full resolution (`needs_detail`). It does **not** read values — OCR and rules do that.

| Path | What it is |
|---|---|
| `src/prompt.ts` | System prompt from the categories and the case template's fields (per template version — cache it); parser and validator for the model's answer; `sectionsFor()` |
| `src/providers.ts` | Request / response adapters: Anthropic, Google, OpenAI and any OpenAI-compatible endpoint (OpenRouter, DeepSeek, a self-hosted vLLM server); retries on 429 / 5xx |
| `src/prices.ts` | List prices per million tokens (researched 2026-11-14 — **check before use**, override with `--prices`) |
| `src/score.ts`, `src/truth.ts` | Ground-truth CSV, scoring and the markdown report |
| `scripts/bakeoff.ts` | The bake-off command |

`src/` follows the shared-code rules (no npm imports, `.ts` imports) so the pipeline worker's `label` stage can reuse it.

## Before running on real images

1. **Client approval (Q21).** Real case images contain personal data (faces, ID cards, RCs, DLs). Send them only to the providers the client has approved. Do not send live case data to DeepSeek's own API (data stored in China); use it, if at all, on non-personal test images.
2. **Keep images and results outside the repository.** The script refuses to write results inside the repo except under `bakeoff-results/` (ignored by git). The `.jsonl` files contain file names and descriptions; `summary.md` / `summary.json` do not.

## Ground truth

Pick **at least 5 complete real cases** (≈ 1,250–1,500 files) across the pilot insurers. Copy the images into one folder (sub-folders per case are fine) and have the office fill a CSV:

```csv
file,categories,needs_detail,fields
case01/IMG_0001.jpg,vehicle_photo,no,-
case01/IMG_0002.jpg,odometer_photo;chassis_engine_photo,yes,odometer_at_entry;chassis_no
case01/IMG_0003.jpg,rc_document,yes,reg_number;reg_date;engine_no;chassis_no
```

- `file`: path relative to the images folder.
- `categories`: one or more codes from `config/templates/_categories.yaml`, separated by `;`.
- `needs_detail`: `yes` when the report needs text, numbers or a small detail from the image at full resolution; `no` for general views. Leave blank if unsure.
- `fields` (optional): the report fields of the bake-off template (`--template`) this image is evidence for, by key, separated by `;`; `-` for none; blank if not marked. The office should mark fields for at least 2 of the 5 cases; it takes longer than labels.

PDFs are skipped (they get the PDF text layer and file-name rules); convert scanned pages to JPEG first if they should be included.

## Run

```bash
npm install -w services/labeller        # once (sharp, yaml)

export ANTHROPIC_API_KEY=… GEMINI_API_KEY=… OPENAI_API_KEY=… OPENROUTER_API_KEY=…

# 1. dry run: resizes the images, shows the prompt, sends nothing
npm run bakeoff -w services/labeller -- --images ~/toyam-samples/images --truth ~/toyam-samples/truth.csv --dry-run

# 2. small smoke run
npm run bakeoff -w services/labeller -- --images ~/toyam-samples/images --truth ~/toyam-samples/truth.csv \
    --models anthropic:claude-haiku-5-5 --limit 20 --out ~/toyam-bakeoff/smoke

# 3. full run
npm run bakeoff -w services/labeller -- --images ~/toyam-samples/images --truth ~/toyam-samples/truth.csv \
    --template config/templates/igi-motor-od.yaml \
    --models anthropic:claude-haiku-5-5,google:gemini-2.5-flash-lite,google:gemini-3.1-flash-lite,openai:gpt-5.4-nano,openrouter:qwen/qwen3-vl-8b-instruct \
    --out ~/toyam-bakeoff/run1
```

Use one template per run (one insurer's cases); `--template` adds the field list to the prompt (≈ 2,200 tokens in total) and scores field matching. Without it only labels are tested.

## Production flow (D37)

Standard API only; the Batch API is not used because labels must arrive within seconds (D30).

1. Claude Haiku 5.5 labels every file as it arrives, one image per call, with the per-template prompt cached.
2. Files whose top label confidence is below the bake-off threshold are re-labelled immediately by Claude Sonnet 5.5 (same ~384 px); its label replaces Haiku's under a new `pipeline_version`.
3. Estimated cost at 90k images a month: about $7 (Haiku) + $13 (Sonnet on ~10 %) = about $20.
4. **Fallback** if Haiku fails the pass marks: Sonnet on numbered 6x6 collages (D36), about $90 a month, keeping single-image calls for files an operator is waiting on.

The bake-off supplies the threshold and the Haiku-passes check.

### Collage arm (D36)

`--layouts single,6x6` runs every model twice: one image per call, and numbered 6×6 collages (36 cells on a 1932-px canvas, 315 px per cell, one case per collage). The planned comparison:

```bash
npm run bakeoff -w services/labeller -- --images ~/toyam-samples/images --truth ~/toyam-samples/truth.csv \
    --template config/templates/igi-motor-od.yaml \
    --models anthropic:claude-haiku-5-5,anthropic:claude-sonnet-5-5 --layouts single,6x6 --out ~/toyam-bakeoff/collage
```

The collages are saved under `collages/6x6/` in the results folder (personal data: keep it outside git) so mix-ups can be checked by eye; the `.jsonl` lines name the collage and cell. A cell the model skipped, numbered twice or put out of range counts as **failed**. `--collage-px` changes the canvas (1932 px suits Claude's high-resolution tier; other providers may downscale it).

Options: `--size` (long edge in px, default 384; run again with `--size 1024` to measure the escalation pass), `--concurrency` (default 4), `--limit`, `--prices prices.json` (same shape as `DEFAULT_PRICES`), `--categories`.

Model ids change often — confirm each id on the provider's model list before the run. The full run of five models on 1,500 images costs roughly one to three dollars (the field list makes the prompt longer; providers cache it after the first calls).

### Self-hosted open-weight model

Any OpenAI-compatible server works, e.g. vLLM on a rented GPU:

```bash
vllm serve Qwen/Qwen3-VL-8B-Instruct --max-model-len 8192          # on the GPU machine
LOCAL_VLM_BASE_URL=http://<gpu-host>:8000/v1 npm run bakeoff -w services/labeller -- … --models local:Qwen/Qwen3-VL-8B-Instruct
```

There is no token price for `local`; compare its latency with the hourly GPU price instead (images per hour ÷ GPU cost per hour).

## Reading the report

`summary.md` has, per model:

- **Accuracy**: the top label is one of the office's categories. Failed calls count as wrong. Split into **documents** and **photos**.
- **Fields: precision / recall** (with `--template` and a `fields` column): of the fields the model matched, how many the office also marked; of the office's fields, how many the model found. Reported, not yet a pass mark — set one after the first run.
- **Descriptions**: share of answers with a description. Read a sample in the `.jsonl` files: they should appear for damage, scenes and unclear images, and not for routine documents.
- **Detail recall**: share of `needs_detail = yes` files the model flagged. A miss means a number that would not have been read — the most expensive error.
- **Confidence routing**: for each threshold, the share of images the model would handle alone and its accuracy on them. Choose the threshold where accuracy meets the pass mark; the rest is escalated.
- **Per-category recall / precision** and the **most frequent mistakes** — fix these with better category descriptions before switching models.
- **Cost** per image, per case (300 files) and per month (90k files); for collages, the call's cost is shared by its cells. **Latency** p50 / p95 — for collages, the whole collage's latency (and in production, also the wait for 36 files).

**Pass marks (D34):** documents ≥ 95 %, photos ≥ 90 %, "needs detail" recall ≥ 97 %. Choose the cheapest model that passes after escalation; prefer a model available in an approved region (Q21). Record the choice in `docs/07-decisions-and-open-questions.md` (Q20).

## Tests

```bash
npm test -w services/labeller
```

## Ground-truth labelling tool (6.9)

`tools/truth-labeller.html` is a single offline file for the office to build `truth.csv`. Nothing is installed and nothing is uploaded: the images are read by the browser from the local disk and never leave the PC.

- Rebuild after changing categories or templates: `npm run build:truth-labeller` (rewrites the data embedded in the HTML from `config/templates/`; a test fails if the categories go stale).
- Use: open the file in Chrome, click "Open image folder" and pick the root (one sub-folder per case), pick the template, then label each image. Keys: left/right = previous/next, the letter or digit shown on a category button selects it (up to 3, in order), D = needs detail, Enter = save and go to the next. Tick the report fields the image is evidence for (none ticked is exported as `-`).
- Progress is kept in the browser per folder name and template, so re-opening the same folder later restores the answers. Only saved images are exported.
- "Export truth.csv" downloads the file. Put it next to the images and run `npm run bakeoff -- --images <root> --truth truth.csv --template <name>`; the paths in it are relative to the chosen root.
- Limit of the CSV format: a file path that starts with `#` would be read as a comment, so avoid such folder names.
