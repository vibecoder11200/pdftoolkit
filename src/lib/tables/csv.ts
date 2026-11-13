/*
 * Phase-5 CSV emitter (plan 261112-0955 step 6) — OWN emitter, no library.
 * Safety default: spreadsheet-safe mode neutralizes formula/ctrl injection
 * prefixes (=, +, -, @, tab, CR and the full-width variants) by prefixing a
 * straight apostrophe, and reports the transformed cell count. RAW mode is
 * an explicit caller decision (UI confirmation) and is never the default —
 * the raw output is byte-honest but unsafe to double-click into Excel.
 *
 * Fidelity note encoded here on purpose: CSV cannot promise leading-zero
 * preservation through Excel double-click or roundtrip safety; the UI
 * points exact-text needs at XLSX.
 */

export interface CsvOptions {
  /** Field separator. Default ','. */
  delimiter: ',' | ';' | '\t';
  /** UTF-8 BOM (Excel default-open needs it for non-ASCII). Default true. */
  bom: boolean;
  /** Neutralize dangerous leading characters (default TRUE = safe). */
  safe: boolean;
  /** Quote every field regardless of content (default true). */
  quoteAll: boolean;
}

export const CSV_DEFAULTS: CsvOptions = {
  delimiter: ',',
  bom: true,
  safe: true,
  quoteAll: true,
};

export interface CsvResult {
  /** UTF-8 bytes (BOM included when requested) — ready for the delivery contract. */
  bytes: Uint8Array;
  /** Cells transformed by safe-mode neutralization. */
  transformedCells: number;
  transformedExamples: string[];
}

const DANGEROUS = new Set(['=', '+', '-', '@', '\t', '\r']);
const FULLWIDTH = new Set(['＝', '＋', '－', '＠']);

function neutralize(text: string): { text: string; transformed: boolean } {
  if (text.length === 0) return { text, transformed: false };
  const first = text[0]!;
  if (DANGEROUS.has(first) || FULLWIDTH.has(first) || first === '　') {
    return { text: `'${text}`, transformed: true };
  }
  // Control characters anywhere -> strip (C0 except \t handled above; \n kept: it
  // is inside a quoted field and legal CSV).
  let stripped = false;
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 && ch !== '\n' && ch !== '\t') {
      stripped = true;
      continue;
    }
    out += ch;
  }
  return { text: out, transformed: stripped };
}

function quoteField(field: string, delimiter: string, quoteAll: boolean): string {
  const needs =
    quoteAll ||
    field.includes('"') ||
    field.includes('\n') ||
    field.includes('\r') ||
    field.includes(delimiter);
  if (!needs) return field;
  return `"${field.replaceAll('"', '""')}"`;
}

export function emitCsv(
  rows: string[][],
  options: Partial<CsvOptions> = {},
): CsvResult {
  const opts = { ...CSV_DEFAULTS, ...options };
  const transformedExamples: string[] = [];
  let transformedCells = 0;
  const body = rows
    .map((row) =>
      row
        .map((raw) => {
          let text = raw;
          if (opts.safe) {
            const n = neutralize(text);
            if (n.transformed) {
              transformedCells += 1;
              if (transformedExamples.length < 5) transformedExamples.push(raw);
            }
            text = n.text;
          }
          return quoteField(text, opts.delimiter, opts.quoteAll);
        })
        .join(opts.delimiter),
    )
    .join('\r\n');
  const text = `${opts.bom ? '\uFEFF' : ''}${body}`;
  const bytes = new TextEncoder().encode(text);
  return { bytes, transformedCells, transformedExamples };
}
