# Processing pipeline worker (M6, D34–D38)

One always-on container (D38) that takes the jobs the database queues for every new evidence file
(`trg_evidence_enqueue`) and runs the stages of `docs/10-processing-pipeline.md` in rank order:
`text_extract → label → ocr → field_suggest`. Service-role key server-side only; the apps never talk to it.

| Stage | What it does now | Status |
|---|---|---|
| `text_extract` | PDF text layer (pdf.js) → `evidence_ocr` rows, engine `pdf_text_layer`, one per page with text (first `PDF_MAX_PAGES`); `skipped` (`no_text_layer`, `not_pdf`) otherwise | done |
| `label` | One call per file: the field app's 384 px copy (`evidence_derivatives`), else the original shrunk here (sharp, EXIF dropped), else for PDFs their text (text layer) or page 1 rendered at 384 px (scans); OCR text the file already has (device OCR first) is added after the image as an excerpt, Aadhaar-like numbers masked. Per-template system prompt (`buildSystemPrompt`, cached in memory, Anthropic prompt caching) → `parseLabelAnswer` → `record_llm_labels()` (labels, description on the first row, `needs_detail`, LLM field matches — rows from the category → field map (`category_map`) are left alone —, model `provider/model-id`). Top confidence below `LABEL_ESCALATION_THRESHOLD` (or an unusable answer) → escalation model at once under `<version>+esc`; the first model's labels are kept inactive (D37). | done (no paid API called in development) |
| `ocr` | Skips when `ocr_wanted()` is false, when a PDF text layer exists or a current `mlkit_device` row exists (phone OCR; reason `device_ocr_present`) unless its confidence is below `OCR_DEVICE_MIN_CONFIDENCE`; engine `none` → `skipped` / `no_ocr_engine_configured`; engine `http` → PaddleOCR sidecar, one `evidence_ocr` row per page | interface + sidecar; PaddleOCR itself not run here |
| `field_suggest` | Pattern rules on the current OCR rows of any engine (text layer, `mlkit_device`, server) (registration, 17-char VIN, engine no., DL no., policy / claim no., dates → ISO, amounts, odometer) for the fields the label matched plus the fields of sections listing the file's categories → `record_field_suggestions()` (pending rule suggestions replaced, decided ones kept) | done |

## Layout

| Path | |
|---|---|
| `src/main.ts` | Entry point: config, Supabase client, stages, worker, health server, signals |
| `src/config.ts` | Environment → config (pure, tested); `describeConfig()` for the start-up log without secrets |
| `src/worker.ts` | Polling loop: claim up to the concurrency limit, idle / error back-off, stale-job recovery, graceful shutdown |
| `src/db.ts` | `PipelineDb` gateway (Supabase implementation; tests use a fake) |
| `src/storage.ts` | R2 presigned GET (`supabase/functions/_shared/r2/presign.ts`, read-only token) and Supabase Storage (`email-raw`); size caps; SHA-256 check against the database |
| `src/media.ts` | sharp resizer, pdf.js text layer and first-page render (@napi-rs/canvas); loaded lazily |
| `src/models.ts` | Label models: provider API (`services/labeller/src/providers.ts`) and the `manual` stand-in |
| `src/template-context.ts` | System prompt, codes, field keys and section maps per template version |
| `src/stages/*.ts` | The four stages |
| `src/ocr-engine.ts` | OCR engine interface, `none` and `http` engines, sidecar response parser (contract in the file header) |
| `src/rules.ts` | Field value rules (pure) |
| `ocr-sidecar/` | Minimal PaddleOCR HTTP sidecar (Python, standard-library server) + Dockerfile |
| `Dockerfile` | Worker image (Node 22 slim), built from the repository root |
| `test/` | node:test suites with fakes; `test/integration/` runs against the local stack |

## Environment

| Variable | Default | |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | required | Service role, server-side only |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_READ_ACCESS_KEY_ID`, `R2_READ_SECRET_ACCESS_KEY` | – | Read-only R2 token (field files and copies); without them R2 files fail and are retried |
| `LABEL_PROVIDER` | `anthropic` if `ANTHROPIC_API_KEY` is set, else `off` | `anthropic`, `google`, `openai`, `openrouter`, `deepseek`, `local`, `manual`, `off`. **`off` leaves label jobs queued** (and the later stages of those files wait behind them); a provider without its key is treated as `off` with a warning — never silently skipped |
| `ANTHROPIC_API_KEY` (or `GEMINI_API_KEY`, `OPENAI_API_KEY`, …) | – | Per `services/labeller/src/providers.ts` |
| `LABEL_MODEL` | `claude-haiku-5-5` for anthropic | Model id; other providers must set it |
| `LABEL_ESCALATION_MODEL` | `claude-sonnet-5-5` for anthropic | `off` disables; `provider:model-id` for another provider |
| `LABEL_ESCALATION_THRESHOLD` | `0.6` | Top label confidence below this → escalation. 0.6 from the 2026-11-26 Haiku test (0.7 sent 26 % of field photos to Sonnet, 7 of 8 of them already right); confirm with the bake-off (Q20) |
| `LABEL_EFFORT` | `default` | Anthropic `output_config.effort` (`low`, `medium`, `high`); default = the model's own, as in the bake-off |
| `LABEL_MANUAL_DIR`, `LABEL_MANUAL_NAME`, `LABEL_MANUAL_TIMEOUT_S` | –, `human`, `1800` | Manual stand-in (below). The folder must be outside the repository |
| `LABEL_PDF_TEXT_CHARS` | `4000` | PDF text sent to the model, at most |
| `LABEL_OCR_EXCERPT_CHARS` | `600` | Existing OCR text added after the image (Aadhaar-like numbers masked); `0` = off |
| `OCR_ENGINE` | `none` | `none` or `http` |
| `OCR_URL`, `OCR_TOKEN`, `OCR_TIMEOUT_S`, `OCR_MAX_PAGES` | –, –, `120`, `10` | PaddleOCR sidecar |
| `OCR_DEVICE_MIN_CONFIDENCE` | `0.5` | A current `mlkit_device` row at or above this mean confidence (or without one) → server OCR skipped |
| `PIPELINE_STAGES` | all four | Comma list, e.g. run OCR on a second container |
| `PIPELINE_CONCURRENCY` | `4` (`8` manual) | Jobs in flight |
| `POLL_MS`, `POLL_MAX_MS` | `1000`, `15000` | Idle back-off from / to |
| `STALE_MINUTES` | `30` | `running` jobs older than this are handed back (also this worker's own at start) |
| `SHUTDOWN_GRACE_MS` | `20000` | On SIGTERM: wait for running jobs, then abort and hand them back |
| `WORKER_ID` | `pipeline-<hostname>` | Keep it stable across restarts (stale recovery) |
| `HEALTH_PORT` | `8080` | `GET /healthz`: 200 while polling, 503 when stuck or stopping; `0` = off |
| `MAX_FILE_MB`, `PDF_MAX_PAGES`, `FIELD_MATCH_MIN_SCORE`, `LOG_LEVEL` | `50`, `30`, `0.3`, `info` | |

## Run locally

```bash
npm ci                                                   # once, at the repository root
eval "$(npx -y supabase@3.1.0 status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
export SUPABASE_URL=$API_URL SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY

# manual stand-in: no API key, nothing leaves the machine
cd services/pipeline
LABEL_PROVIDER=manual LABEL_MANUAL_DIR=~/toyam-manual-labels HEALTH_PORT=8090 \
  npx -y node@22.22.1 --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/main.ts
```

(`npm start` works with any Node ≥ 22.18 that has type stripping; the Ubuntu `/usr/bin/node` does not.)

With `LABEL_PROVIDER=manual` each label request appears as `~/toyam-manual-labels/requests/<evidence>.<version>.json`
(evidence id, template version, allowed category codes and field keys, the instruction) next to the 384 px image
(`.jpg`) or the PDF text (`.txt`); the system prompt is in `prompts/<hash>.txt`. Write the answer — the JSON the
prompt asks for, optionally with `"model": "provider/model-id"` naming who answered — to `answers/<same name>.json`
(or put many in one `answers.json` object keyed by request id). The worker picks it up within a second and moves
the files to `done/`. Unanswered requests time out (`LABEL_MANUAL_TIMEOUT_S`) and the job is retried with the
database back-off. The folder holds case images: keep it outside the repository (enforced) and delete it after use.

Tests (the system `/usr/bin/node` has no type stripping):

```bash
cd services/pipeline
npx -y node@22.22.1 --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test "test/*.test.ts"     # unit + sidecar contract
# end to end on the local stack with the manual model (under the shared lock; db reset restores the seed)
flock /tmp/toyam-localdb.lock -c 'SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<local key> \
  npx -y node@22.22.1 --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test "test/integration/*.test.ts"'
npm run typecheck -w services/pipeline
```

## Deploy (not done; decisions pending)

1. **Host:** one always-on container in a Mumbai region (D38), e.g. a small VM or container service (1 vCPU, 1 GB is
   enough for the worker; the OCR sidecar needs more, below). Not deployed yet.
2. Build and push from the repository root: `docker build -f services/pipeline/Dockerfile -t <registry>/toyam-pipeline:<tag> .`
3. Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, the four R2 read variables, and the model key once
   **Q21** allows images to go to a provider. Until then run with `LABEL_PROVIDER=off` (label jobs wait) or `manual`.
4. Health check on `GET /healthz` (port 8080); restart on failure. Keep `WORKER_ID` stable. One replica (more work,
   but jobs are claimed with `FOR UPDATE SKIP LOCKED`, so a second replica is safe).
5. OCR: run `ocr-sidecar` next to the worker and set `OCR_ENGINE=http OCR_URL=http://<sidecar>:8866 OCR_TOKEN=…`.

### OCR sidecar (PaddleOCR, CPU)

```bash
docker build -f services/pipeline/ocr-sidecar/Dockerfile -t toyam-ocr services/pipeline/ocr-sidecar
docker run --rm -p 8866:8866 -e OCR_TOKEN=… toyam-ocr
```

`POST /ocr` with the file bytes (`Content-Type` image/* or application/pdf, `X-Max-Pages`), answer
`{engine, engine_version, lang, pages: [{page_no, width, height, text, mean_confidence, blocks: [{text, bbox: [x, y, w, h], conf, line}]}]}`
(full contract in `src/ocr-engine.ts`). One OCR at a time; images over `OCR_MAX_EDGE` (2400 px) are shrunk and the
boxes scaled back; PDFs are rendered at `PDF_DPI` (200) with pypdfium2. **Not verified here:** PaddleOCR is not
installed in the development environment, so the image was not built and the Paddle code path is untested; the HTTP
contract is tested against the same server in `OCR_SIDECAR_ENGINE=fake` mode (`test/sidecar.test.ts`). Pin exact
versions in `requirements.txt` after the first build. Sizing to decide: PaddleOCR CPU wants ~2 GB RAM and 2 vCPU for
a few seconds per page; at ~10 % of 90k files a month needing server OCR, one such container is enough.

## Costs and logs

Every model call logs one JSON line `event: model_call` with model, input / cached / cache-write / output tokens,
`cost_usd` (list prices in `services/labeller/src/prices.ts`), latency and the top confidence — ids only, never file
names, OCR text, descriptions or answers. **Gap (6.10):** there is no cost table yet; the monthly budget and the 80 %
alert need one (or a log sink that can sum these lines).

## Gaps

- No cost table / budget alert (6.10); costs are in the logs only.
- Server OCR is skipped until the sidecar runs (`OCR_ENGINE=none`); with OCR off, photos get no field suggestions.
- The vision "second opinion" on numbers at full resolution (docs/10) is not built.
- Device OCR rows (`mlkit_device`) are used when present; the phone side and its RPC are being added separately.
- Derivatives are assumed on R2 (D53 adds a storage backend to `evidence_derivatives` when evidence moves to Supabase Storage).
- Insurer file names are not sent to the model (they are labelled by `filename_rule` first).
- Audio / video label jobs are skipped (`unsupported_type_*`).
