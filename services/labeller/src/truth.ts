// Ground-truth CSV for the bake-off: one row per image, filled in by the office.
//
//   file,categories,needs_detail,fields
//   case01/IMG_0001.jpg,vehicle_photo,no,
//   case01/IMG_0002.jpg,odometer_photo;chassis_engine_photo,yes,odometer;chassis_no
//   case01/IMG_0003.jpg,spot_photo,no,-
//
// `file` is relative to the images folder; `categories` are codes from _categories.yaml separated by
// ";"; `needs_detail` is yes/no (blank = not marked); `fields` (optional column) are field keys of
// the bake-off template separated by ";", "-" for "no field", blank = not marked.
import type { TruthRow } from './score.ts';

export function parseTruthCsv(text: string, allowed: Set<string>, allowedFields?: Set<string>): { rows: TruthRow[]; errors: string[] } {
  const rows: TruthRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const cells = splitCsvLine(line);
    if (i === 0 && cells[0]?.toLowerCase() === 'file') return;   // header
    const [file = '', cats = '', detail = '', fieldCell = ''] = cells.map((c) => c.trim());
    const where = `line ${i + 1}`;
    if (!file) return void errors.push(`${where}: file is empty`);
    if (seen.has(file)) return void errors.push(`${where}: ${file} listed twice`);
    seen.add(file);
    const codes = cats.split(';').map((c) => c.trim()).filter(Boolean);
    if (!codes.length) return void errors.push(`${where}: no category for ${file}`);
    const unknown = codes.filter((c) => !allowed.has(c));
    if (unknown.length) return void errors.push(`${where}: unknown category ${unknown.join(', ')}`);
    const d = detail.toLowerCase();
    if (d && !['yes', 'no', 'y', 'n', 'true', 'false', '1', '0'].includes(d)) return void errors.push(`${where}: needs_detail must be yes or no`);
    let fields: string[] | null = null;
    if (fieldCell === '-') fields = [];
    else if (fieldCell) {
      if (!allowedFields) return void errors.push(`${where}: fields given but no --template to check them against`);
      fields = fieldCell.split(';').map((f) => f.trim()).filter(Boolean);
      const unknownFields = fields.filter((f) => !allowedFields.has(f));
      if (unknownFields.length) return void errors.push(`${where}: unknown field ${unknownFields.join(', ')}`);
    }
    rows.push({ file, codes, needs_detail: d === '' ? null : ['yes', 'y', 'true', '1'].includes(d), fields });
  });
  return { rows, errors };
}

/** Split one CSV line; supports double-quoted cells with "" escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cell); cell = ''; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}
