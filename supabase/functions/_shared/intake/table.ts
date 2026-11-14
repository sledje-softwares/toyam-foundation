// Label/value lookup over table rows (from HTML tables or tab/space separated text).
// Insurer intimation mails are "label | value | label | value" grids split into blocks by
// single-cell heading rows ("Insured Details", "Driver Details", ...).

export function normLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9%#]+/g, ' ').trim();
}

export interface RowIndex {
  rows: string[][];
  sections: string[];       // normalised heading in force for each row
}

export function buildIndex(rows: string[][]): RowIndex {
  const sections: string[] = [];
  let current = '';
  for (const row of rows) {
    const filled = row.filter((c) => c !== '');
    if (filled.length === 1 && filled[0].length <= 60 && /[a-z]/i.test(filled[0]) && !/^\d/.test(filled[0])) {
      current = normLabel(filled[0]);
    }
    sections.push(current);
  }
  return { rows, sections };
}

export interface Located {
  value: string;
  row: number;
  section: string;
}

/**
 * First non-empty value for `label` (optionally only inside a block whose heading contains
 * `within`). A value that is itself a known label is treated as empty (misaligned text rows).
 */
export function findLabel(index: RowIndex, label: string, within?: string, knownLabels?: Set<string>): Located | null {
  const L = normLabel(label);
  const W = within ? normLabel(within) : null;
  let emptyHit: Located | null = null;
  for (let r = 0; r < index.rows.length; r++) {
    if (W && !index.sections[r].includes(W)) continue;
    const cells = index.rows[r];
    for (let i = 0; i < cells.length; i++) {
      const raw = cells[i];
      const n = normLabel(raw);
      let value: string | null = null;
      if (n === L) {
        value = cells[i + 1] ?? '';
        if (value !== '' && knownLabels?.has(normLabel(value))) value = '';
      } else if (n.startsWith(L + ' ') && /[:：]/.test(raw)) {
        // "Policy Number: 1234" in one cell / line
        const idx = raw.search(/[:：]/);
        if (normLabel(raw.slice(0, idx)) === L) value = raw.slice(idx + 1).trim();
      }
      if (value === null) continue;
      const hit = { value: value.replace(/\s+/g, ' ').trim(), row: r, section: index.sections[r] };
      if (hit.value !== '') return hit;
      emptyHit ??= hit;
    }
  }
  return emptyHit;
}
