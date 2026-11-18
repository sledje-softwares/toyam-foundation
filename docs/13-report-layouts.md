# 13 — Report layouts (D51, build plan 7.7)

Reports are generated from the workspace's field values, as **PDF and Word**, with an exact copy of each insurer's layout. The insurer's own Word files are not filled. A layout is **structured data** (not HTML) stored per template version in `public.case_templates.report_layout` (jsonb) and written only by the template loader (rule 8).

```
config/templates/icl-motor-od.yaml ── report_layout: layouts/icl-motor-od.yaml
config/templates/layouts/icl-motor-od.yaml ── assets: {letterhead: {file: assets/toyam-letterhead.jpg}}
        │  npm run templates:load (validate.ts, assets embedded as base64)
        ▼
case_templates.report_layout (jsonb, part of config_sha256 → a layout change is a new version)
        │  prepare_report_version(case) → report-generate (edge function)
        ▼
bind.ts (layout + ReportData → resolved document) ──► html.ts → Browser Rendering /pdf → PDF
                                                    └► docx.ts → .docx (OOXML, STORE zip)
```

Code: `supabase/functions/_shared/report/` — `spec.ts` (types, placeholders, `defaultLayout()`), `validate.ts`, `format.ts`, `image.ts`, `bind.ts`, `html.ts`, `docx.ts`, `pdfmake.ts` (browser PDF, see "PDF writer (pdfmake)"). Tests: `services/intake/test/report-*.test.ts`, fictional example `services/intake/test/fixtures/report/example-layout.yaml` (uses every block type — copy from it).

## Files and loading

- The template YAML names its layout: `report_layout: layouts/<template>.yaml` (relative to the template file; no `..`, no absolute paths). An inline object is also accepted but discouraged.
- Layout files live in `config/templates/layouts/` (a sub-folder, so the loader does not take them for templates). Image files for `assets` live beside them (e.g. `layouts/assets/`), paths relative to the layout file.
- `npm run templates:json` (dry run) reads the layout, embeds asset files (`{file: …}` → `{mime, width, height, data_base64}`; JPEG or PNG only, ≤ 3 MB), and validates it against the template's own field keys and section keys. Errors are printed as `report_layout $.body[3].rows[2].cells[1]: …`; nothing is loaded while any error remains.
- `npm run templates:load` sends the resolved layout inside the template JSON; `load_case_template()` stores it (migration `20261117400000_template_report_layout.sql`). The layout is hashed with the rest of the config, so changing it creates a new template version; cases keep the version they started with.
- Do not commit signatures or seals if they should stay out of git: declare them `{runtime: true}` and let the generator supply the bytes (`ReportData.assets`).

## Layout reference

Top level (unknown keys are errors everywhere):

| Key | Type | Notes |
|---|---|---|
| `version` | `1` | required |
| `name` | text | document title prefix (`<name> — <case ref>`) |
| `page` | `{size: A4\|Letter\|Legal, orientation?: portrait\|landscape, margin_mm: {top,right,bottom,left}, header_mm?, footer_mm?}` | `header_mm` / `footer_mm`: distance of header / footer from the page edge. The header must fit inside the top margin (Chrome clips it; Word pushes the body down) |
| `font` | `{family, fallback?, size_pt, color?, line_height?}` | `family` is used by Word; `fallback` is the CSS list for the PDF (e.g. `Carlito, Arial, sans-serif` for Calibri, `Caladea, serif` for Cambria) |
| `paragraph_spacing_pt` | number | gap between paragraphs of one value (blank line typed in the workspace); default 6 |
| `date_format`, `datetime_format` | pattern | defaults `dd.MM.yyyy` and `dd.MM.yyyy hh:mm a` |
| `empty_value` | text | printed for an empty `{{field.x}}` without `|default` (e.g. `NA`); default empty |
| `styles` | `{name: TextStyle}` | named text styles; `heading1`…`heading3` restyle headings |
| `table_styles` | `{name: TableStyle}` | named table styles |
| `assets` | `{name: {file} \| {runtime: true, description?}}` | images (letterhead, logo, seal) |
| `header`, `footer` | blocks | repeated on every page; may use `{{page}}` / `{{pages}}`; allowed blocks: paragraph, heading, image, table (cells: paragraph, heading, image, spacer, rule), spacer, rule, group |
| `body` | blocks | required |

**TextStyle** `{use?, font?, size_pt?, color?, bold?, italic?, underline?, caps?, align?: left|center|right|justify, background?, space_before_pt?, space_after_pt?, line_height?, indent_mm?}`. Colours are `#RRGGBB`. `use` extends a named style. On a cell, `background` shades the cell. A style reference is a name or an inline object.

**TableStyle** `{use?, border?: {width_pt, color, style?: solid|dashed} | none, padding_x_mm?, padding_y_mm?, cell_style?, label_style?, value_style?, heading_style?, space_after_pt?}`. Defaults: 0.5 pt black grid, padding 1.5 / 0.5 mm, 6 pt after. `heading_style` defaults to bold, centred.

### Blocks

Every block may carry `when` (see Conditions).

| `type` | Keys | Output |
|---|---|---|
| `paragraph` | `text` (placeholders; blank line = new paragraph, single line break kept) **or** `runs: [{text, style}]` (differently styled pieces, e.g. letterhead name); `style`; `markup: true` turns `**bold**` (in values too) into bold | paragraphs; empty result → nothing |
| `heading` | `text`, `level` 1–3, `style` | bold paragraph kept with the next block |
| `list` | `field` (split per `split`, multi_choice per element) **or** `items: [text…]` (empty results dropped); `ordered`, `start`, `indent_mm` (default 6), `style`, `empty_text`, `markup` | `1.` / `•` markers hanging in the indent; an item's later paragraphs stay indented |
| `table` | `columns: [relative widths]` (1–12), `rows`, `style` (name or inline), `width_pct` | real table (Word: `w:tbl`, fixed layout) |
| `image` | `asset`, `width_mm?`, `height_mm?`, `max_height_mm?`, `align` | natural size at 96 dpi capped to the width, or as sized; missing asset → dashed box |
| `photos` | `section` (template section key), `columns` 1–4 (default 2), `max_height_mm`, `gap_mm` (default 3), `captions`, `caption_style`, `limit`, `border` (default none), `empty_text` | grid of the photos selected for that section, each filling its column; missing / unreadable photo → dashed box "Photo not available: caption" |
| `spacer` | `height_mm` | vertical gap |
| `rule` | `color`, `width_pt` | horizontal line |
| `page_break` | — | new page |
| `group` | `blocks`, `keep_together` | shared condition; keep on one page where possible |

### Table rows

| Row | Keys | Notes |
|---|---|---|
| cells | `cells: [Cell…]`, `header` (repeat at the top of each page; first rows only), `keep_together`, `height_mm` (minimum) | |
| heading | `heading: text`, `style`, `header` | one cell across all columns, table `heading_style` |
| field | `field: key`, `label?` (default: the template label), `value?` (text with placeholders, default `{{field.<key>}}`), `label_style`, `value_style`, `label_span` (default 1), `markup` | label cell + value cell across the remaining columns |
| repeat | `repeat: {field, split?}`, `cells` (may use `{{item}}`, `{{index}}`), `empty: [Cell…]` (one row when there are no items) | one row per item |

**Cell**: a string (= `{text}`) or `{text | runs | blocks, colspan, rowspan, style, valign: top|middle|bottom, background, border: none, markup}`. `blocks` inside cells: paragraph, heading, list, image, photos, spacer, rule, group (no nested tables). The validator checks that every row covers exactly the table's columns, counting cells still covered by a `rowspan` from above; a rowspan may not run past the last row, and rows inside a rowspan (and the row that starts one) cannot be conditional or repeat rows — put the condition on the table instead.

### Conditions (`when`)

`{field: key}` (filled), `{field: key, filled: false}`, `{field, equals: text}`, `{field, not_equals: text}`, `{field, in: [..]}` (case-insensitive, trimmed), `{photos: section}` (any photo selected), `{all: [..]}`, `{any: [..]}`, `{not: cond}`. A multi_choice `[]` counts as empty.

### Placeholders

`{{case.<fact>}}`, `{{field.<key>}}`, `{{item}}` / `{{index}}` (repeat rows), `{{page}}` / `{{pages}}` (header / footer). Facts: `case_ref, insurer_code, insurer_name, claim_no, policy_no, template_key, template_name, template_version, office_owner_name, received_at, due_at, generated_at, report_version` (`*_at` are timestamps shown in India time).

Formatters, chained left to right: `{{field.loss_date|date:"d MMMM yyyy"|upper}}`.

| Formatter | Effect |
|---|---|
| `date[:"pattern"]` | tokens `yyyy yy MMMM MMM MM M dd d HH H hh h mm ss a`, `'literal'`, `''` = quote. Stored dates `yyyy-mm-dd`, datetimes `yyyy-mm-ddThh:mm`, zoned timestamps and `dd/mm/yyyy` are read; other text is printed as typed |
| `upper`, `lower`, `title` | case |
| `yesno[:"Yes text|No text"]` | maps Yes/No/true/false |
| `join[:"sep"]` | multi_choice (JSON array) with a separator, default `, ` |
| `number` | Indian grouping `12,34,567` |
| `currency[:"prefix"]` | prefix (default `₹ `) + Indian grouping |
| `default:"text"` | when empty (`empty_value` is not applied then) |
| `prefix:"text"`, `suffix:"text"` | only when not empty |
| `first_line`, `rest_lines` | e.g. a statement's heading line and body |

Without formatters a value prints by its field type: date / datetime by the layout patterns (a datetime without a time uses the date pattern), multi_choice joined with `, `, currency grouped, boolean as stored (`Yes` / `No`, O1), everything else as typed. Values are inserted once and never parsed again: `{{…}}` typed into a field is printed literally.

**Splitting** (`split`, lists and repeat rows): `auto` (default) — items start at lines beginning with `1.` `1)` `•` `-` `*` (markers removed, following lines stay in the item), otherwise one item per line; `lines`; `paragraphs` (blank-line separated); `sections` (separated by a line `---`, e.g. statements: first line = name / relation, rest = statement).

## Writer interface (for report-generate)

```ts
import { bindReport, fieldsFromSections, type ReportData } from '../_shared/report/bind.ts';
import { renderReportHtml } from '../_shared/report/html.ts';   // → { html, headerTemplate, footerTemplate, pdfOptions, warnings }
import { renderReportDocx } from '../_shared/report/docx.ts';   // → Promise<Uint8Array>

const data: ReportData = {
  case: { case_ref, insurer_code, insurer_name, claim_no, policy_no, template_key, template_name, template_version,
          office_owner_name, received_at, due_at, generated_at, report_version },
  fields: fieldsFromSections(prepared.sections),          // key → {type, label, value (stored text)}
  photos: { [section_key]: [{ evidence_id, caption, image: { bytes, mime: 'image/jpeg', width?, height? } | null }] },
  assets: { seal: { bytes, mime } },                       // runtime assets only
};
const out = renderReportHtml(layout, data);                // POST {html: out.html, pdfOptions: out.pdfOptions} to /pdf
const docx = await renderReportDocx(layout, data);         // application/vnd…wordprocessingml.document
```

- Invalid layouts throw `LayoutError` (`.issues`); non-fatal problems (unknown field, unreadable photo, missing runtime asset) are in `warnings` and drawn as placeholders.
- `renderReportHtml(…, {mode: 'preview'})` lays out one page-wide sheet with the header and footer inline for the web preview (same CSP).
- The HTML carries `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'`, images only as `data:` URIs, no URLs: the renderer fetches nothing. `pdfOptions` is Puppeteer-style (`width`, `height`, `margin` in mm, `printBackground`, `displayHeaderFooter`, `headerTemplate`, `footerTemplate` with `pageNumber` / `totalPages` spans).
- Photo pixel size: pass `width` / `height` (e.g. the derivative's `pixel_width` / `pixel_height`) or leave them out to read the JPEG header. Bytes are embedded as given; derivatives must already be upright (Word ignores EXIF orientation).
- A template version without a layout: use `defaultLayout(sections)` from `spec.ts` (heading row per section, label / value rows, photo grid per section) or refuse.

### PDF writer (pdfmake)

`pdfmake.ts` translates the same resolved document into a **pdfmake 0.3** document definition, so the PDF can be built in the office user's browser (D51). Pure, no npm imports; the definition is a plain object plus a few functions (header / footer per page, table line styles, keep-with-next).

```ts
import { renderReportPdfDefinition, pdfmakeFonts } from '../_shared/report/pdfmake.ts';
const { definition, fonts, warnings } = renderReportPdfDefinition(layout, data, { creator, now });
pdfMake.setFonts(pdfmakeFonts(fonts, (file) => `/fonts/${file}`)); // only the files this report uses
const pdf = await pdfMake.createPdf(definition).getBuffer();
```

Mapping (decisions follow `html.ts`, the preview the user approves):

| Resolved model | pdfmake |
|---|---|
| page size, margins (mm) | `pageSize` / `pageMargins` in pt (× 72 / 25.4), orientation from the size |
| header / footer | `header(page, pages)` / `footer(page, pages)` rebuilt per page with `{{page}}` / `{{pages}}` filled; header `header_mm` from the top inside the side margins; footer bottom-aligned `footer_mm` above the edge (a 1-cell table with `verticalAlignment: bottom`) |
| paragraph | `text: [runs]`, `alignment`, `margin [indent, before, 0, after]`, `preserveLeadingSpaces`; adjacent vertical margins **collapse** like CSS (the larger wins, also into a group); `caps` upper-cased, tabs → 4 spaces; a list marker hangs in the indent (`columns`); a background shades the full width (1-cell table) |
| run style | `font` (key below), `fontSize`, `color`, `bold`, `italics`, `decoration: underline`; `lineHeight` = CSS line height ÷ the font's em box (`REPORT_FONT_EM_HEIGHT`: Carlito 1.2207, Caladea 1.15, Liberation Sans 1.1172) so lines are as tall as in Chrome |
| table | column `widths` = column − 2 × padding − line (pdfmake adds those), per-table `layout` (line width / colour / dash 3-2, padding); `colSpan` / `rowSpan` with the `{}` filler cells pdfmake needs; `fillColor`, `verticalAlignment`, `border: [false×4]` for `border: none` cells; leading `header` rows → `headerRows` |
| image / photo | `images` dictionary of data URLs (one entry per byte array, MIME sniffed), `width` / `height` in pt from the resolved mm, capped to the cell's content width; a missing image is the same dashed `#888` box with the same 8 pt text as HTML ("Photo not available: caption") |
| `keep_together` group | `unbreakable: true`; rows all `keep_together` → `dontBreakRows` |
| heading (`keep_with_next`) | `headlineLevel: 1` + `pageBreakBefore`: a body heading with nothing after it on its page moves to the next page |
| `page_break` | `pageBreak: 'before'` on the next block (a leading, trailing or repeated break adds no empty page) |
| spacer / rule | empty text with a top margin / canvas line with 2 pt above and below |

Fonts (`apps/web/public/fonts/`, see its README): `pdfFontKey(family, fallback)` maps case-insensitively Calibri → `Carlito`, Cambria → `Caladea`, Arial / Helvetica / sans-serif → `LiberationSans` (the substitutes map to themselves; serif / Times → `Caladea`, the only serif shipped); an unknown family tries the layout's fallback list, an unknown run font the layout's default family, finally `Carlito`. `REPORT_FONT_FILES` names the four files per key; `pdfFontsUsed(definition)` lists the keys **and variants** the text really uses (header / footer included) and `pdfmakeFonts(used, source)` builds the descriptors for just those, so the browser fetches e.g. 2–4 files instead of 12 (Carlito is ~650 kB per file).

Measured in Node (test `report-pdfmake.test.ts`, 30 photos of 300 kB, 12 pages each layout): ~9.1 MB PDF, ~0.5–0.7 s wall, ~0.8–1 s CPU in pdfmake + ~0.07 s for the definition.

Known differences from the HTML writer:

- **Unbreakable blocks are guarded by an estimate.** pdfmake silently drops whatever does not fit an unbreakable block (group, `dontBreakRows` row) on one page, so `keep_together` is applied only when a deliberately high height estimate fits 95 % of the page body; a taller group or row breaks normally (Chrome does the same). `keep_together` on a single row of a table whose other rows are not kept is not expressible (pdfmake has no per-row option): such rows can break. `keep_together` groups inside table cells are not kept.
- **Minimum row heights** (`height_mm`) are kept only when the table's rows can all be kept whole (`dontBreakRows`): pdfmake 0.3.13 corrupts the page when a fixed-height row is split at a page end. Otherwise the minimum is dropped. As a side effect, a table with a `height_mm` row moves a row that does not fit to the next page instead of splitting it (like Word's "cantSplit").
- Line boxes: pdfmake puts the extra line height below the text (CSS splits it above and below): text sits ~0.03 em higher. Justified text, long-word breaking and the last line of a paragraph behave like CSS.
- Borders are drawn per cell edge (an edge is drawn when either neighbour has one, close to CSS border-collapse); the table is one line width wider than in HTML (the outer half lines).
- Superscript, links and a different first-page header are not supported (as in the HTML writer).
- **₹ (U+20B9) is only in Carlito.** Caladea and Liberation Sans have no glyph for it, so a `currency` value (default prefix `₹ `) in a Cambria / Arial run prints a missing glyph. No current layout uses `currency`; a layout that does should give it the prefix `Rs. ` or a Calibri run.

### Built in the browser (7.7 piece 3)

The workspace's **Generate report** and **Preview** build the files in the office user's browser (`apps/web/lib/report-build`), as the signed-in user (browser Supabase client, anon key + session; no service-role key):

1. `prepare_report_version` (generate) / `prepare_report_preview` (preview, any status) — the database checks staff, `can_manage_case` and, for generate, the editable status.
2. `assemble.ts`: `preparedProblem` (no / invalid layout, no output format), `planReportPhotos(prepared, mode)` (sections shown by a `photos` block, `imageSources` order, byte budget), `loadReportPhotos(plans, fetcher)` — the fetcher is the hash-checked file cache (`fetchVerified` with the SHA-256 prepare returned for the 1600 px copy / 384 px copy / original); bytes that fail are never placed, the photo becomes a placeholder + warning — and `reportDataFrom`.
3. `files.ts`: `createReportRenderer({pdfmake, loadFont}).render({layout, data, formats, now})` binds once, builds a fresh pdfmake definition per render, loads only the font files it uses into pdfmake's virtual file system (`/fonts/<file>` from the app's origin), switches pdfmake's URL and local-file access off, writes the PDF and (if the template allows) the Word file, and returns `placedKeys` for `placedPhotoRecords` (p_photos = photos actually embedded). It runs in a **Web Worker** (Turbopack bundles `new Worker(new URL('./worker.ts', import.meta.url))` as a classic worker with pdfmake in its own chunks); without a worker it runs on the page, yielding before each writer.
4. SHA-256 (crypto.subtle), upload to `reports/{case_id}/{report_id}/report.{pdf|docx}` (`upsert: false`), `create_report_version`. A failed upload / record keeps the files and the report id for a retry (an "already exists" object of the same size counts as uploaded; `created: false` is success); RV409 or a refusal starts over with a new prepare and a new id.

Measured (`services/intake/test/report-browser-build.test.ts`, Node 22, pdfmake **browser** build, 30 photos: 27 JPEG copies of 250–400 kB + 3 PNG 1600 × 1200 of 1.7 MB, both layouts): PDF ≈ 13.9 MB and Word ≈ 14 MB for 13.9 MB of photos; plan + photos + data ≈ 3 ms (bytes in memory), PDF + Word ≈ 1.2–1.3 s wall. First load of `/reports/[caseRef]` grows by ≈ 0.7 kB gzip; pdfmake (≈ 290 kB gzip), the writers (≈ 20 kB) and supabase-js (≈ 70 kB) load on the first Generate / Preview only; fonts 80–800 kB per file, 2–4 files per report, from the HTTP cache after the first time.

## What the two samples contain (for transcribing them)

Structure only; the sample files hold real personal data — never copy values from them. Check each item off when transcribing into `config/templates/layouts/<template>.yaml`.

### ICICI Lombard Motor OD (`icici lombard/report.pdf`, template `icl-motor-od`)

- [ ] Page: **Letter** (215.9 × 279.4 mm), 12 pages, serif body font (Cambria-like, ~10 pt), table text ~10 pt.
- [ ] Header, every page: an orange band image across the top edge; below it a letterhead image (logo, firm name, registration line) about the full content width. → `assets` (letterhead file from the firm, not cut from the sample) + `image` block(s).
- [ ] Footer, every page: two right-aligned lines (firm address; e-mail), ~9 pt; no page number.
- [ ] Body is one long 2-column table (≈ 40 / 60), thin black grid, labels regular weight (a few bold: conclusion block), values left-aligned.
- [ ] First row: heading "Investigation Report" (bold, centred, grey shading). Section heading rows the same style: Insured details · Vehicle Details · Driver details · Written Statement · Police Intimation details · Garage Visit · Damaged IV images · Observation and Conclusion · Final Conclusion.
- [ ] Opening block: 11 label / value rows (investigator name and contact details are static text, contact is 3 lines; claim no. value bold).
- [ ] Insured details: 7 rows (one row is a government ID number label printed as `NA` — no field exists by rule 7; keep a static `NA` or drop the row after asking the client).
- [ ] Vehicle details: 13 rows; the last 5 rows (previous policy … discrepancy in break-in) share **one merged value cell** (`rowspan: 5`).
- [ ] Driver details: 5 rows, then a **full-width image row** (DL extract screenshot: `photos` columns 1 in a `colspan: 2` cell, section `driver`), then 7 more rows.
- [ ] Written statement: one row, label "Written Statement of Insured (name)" (label with a placeholder), value a justified narrative; then a full-width row with 2 photos side by side (statement photos).
- [ ] GPS timeline: one label / value row, then a 2-photo row of screenshots (section `timeline`).
- [ ] Police intimation: 5 rows with **centred labels**; the first 3 share one merged value (`rowspan: 3`).
- [ ] Garage visit: 9 rows (some labels 3–4 lines long).
- [ ] Damaged IV images: heading row, then a borderless 2-column photo grid without captions running over ~4 pages (≈ 4 photos per page, each ≈ 90 mm tall).
- [ ] Insured visit block (no heading row): 12 rows; the "Discrepancy observed" value is **bold** (`value_style: {bold: true}`).
- [ ] Observation and Conclusion: one row, label "Case summary and observation"; the value cell holds a centred bold sub-heading "Case Summary", justified paragraphs, a centred bold sub-heading "Observation" and a **bulleted list** (cell `blocks`: heading, paragraph, heading, list).
- [ ] Final Conclusion: heading row (bold, underlined, centred) and a **full-width narrative cell** (`colspan: 2`, justified; `markup: true`, office types `**…**` for bold, same as the Reliance conclusion). The Case Summary paragraph supports the same markup.
- [ ] Closing rows: Investigation status (narrative), Repudiate ground, Investigation agency name (static), Report submission date, "Seal and Stamp" with the **seal + signature image** (runtime asset) in the value cell, row ~25 mm tall.
- [ ] After the table: 3 left-aligned lines ("Yours Truly", "For <firm>", blank, "Authorized Signatory").
- [ ] A URL typed in a value prints as plain text (the sample shows a blue link).

### IndusInd / Reliance Motor OD (`reliance od/Updated_…_IR.pdf`, template `igi-motor-od`)

- [ ] Page: **A4**, 11 pages, sans body font (Calibri-like, ~10 pt).
- [ ] Header, every page: small bold underlined registration line at top left; a small logo image on the left with the firm name beside it as runs (large orange bold word + black bold rest) — a borderless 2-column header table (`image` + `runs`); a thin orange band image at the top edge.
- [ ] Footer, every page: **centred page number** only (`{{page}}`).
- [ ] Title paragraph "OD Investigation Report" (bold, centred) above the first table.
- [ ] Each section is its **own table** with a gap after it; first row = heading (bold, centred, no shading); label cells **light-blue shading with bold dark-blue text**; values regular.
- [ ] Insured details: 11 rows; the "RCU Trigger" value is a **numbered list** (≈ 15 items) from the intake field `investigation_points`.
- [ ] Loss / intimation block: a 3-column row of **shaded italic bold** labels followed by one row of 3 values; then 7 label / value rows with the value spanning 2 columns (3-column table, `label_span: 1`).
- [ ] Basic details: heading; 3 shaded italic labels + 3 values; then "If mismatching, reason" and "Brief remarks of the accident" (justified narrative) spanning 2 columns.
- [ ] Accident details: 3-column grid of **alternating label rows (shaded) and value rows**, 6 pairs (some cells empty).
- [ ] FIR / GD details: 12 label rows sharing **one merged value cell** (`rowspan: 12`, `valign: middle`).
- [ ] Driver details: 12 rows. DL extract: heading row + full-width image row.
- [ ] Garage details: 9 rows. Vehicle registration details: 13 rows (last one narrative).
- [ ] If vehicle commercial: 14 label rows sharing one merged value (`rowspan: 14`), then 2 rows.
- [ ] Spot verification: 4 rows (last narrative). Spot photos: heading row + **2 × 2 photo grid inside the table** (bordered cells). Vehicle photos: heading + 2-column grid (≈ 8 photos, one page).
- [ ] Injured details: 9 label rows with one merged value (`rowspan: 9`, centred) + 1 narrative row; this table's labels are **lavender**, not blue (second table style).
- [ ] Written statement collect: heading; 2 shaded header cells (name and relation / statement version); then **one row per statement** (`repeat`, `split: sections`, `{{item|first_line}}` / `{{item|rest_lines}}`).
- [ ] Observation / findings: heading + one full-width cell with a **numbered list** (≈ 12 items; items have continuation paragraphs).
- [ ] Documents collection: heading; header row "Sr. no. / Documents name"; one row per document (`repeat` over `documents_collected`, `{{index}}.`).
- [ ] Reminder letter / document deficiency letter: heading + 3 rows (the sample label "1st" has a superscript — print plain "1st").
- [ ] Conclusion: heading + full-width justified narrative; the last paragraph is bold (`markup: true`, office types `**…**`; the ICICI layout supports it too).
- [ ] Closing table: Investigation status, Repudiate ground (bold value), Agency name (static), Report submission date, Seal and stamp (runtime image).
- [ ] After the table: a disclaimer paragraph, a billing sentence, "Thanking you", then "Yours Sincerely" (left) and "Compiled by: <name>" (right) on one line — a borderless 2-column table; the compiler is the `compiled_by` field.

### Not expressible yet

| Sample feature | Workaround |
|---|---|
| Band image bleeding to the page edge (both letterheads) | place the band inside the margins (full content width) or make it part of the letterhead image |
| Superscript ("1st") | plain text |
| Clickable links | plain text |
| Different first-page header | not needed by either sample |
