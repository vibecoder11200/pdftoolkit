/*
 * Phase-5 XLSX builder (plan 261112-0955 step 5) — ExcelJS (MIT, pinned
 * permissive boundary), imported LAZILY inside the PDF worker by the
 * caller (the entry bundle must never see it). Whole-workbook memory is
 * the honest trade-off (no browser streaming in exceljs) — the cell
 * budget above bounds it.
 *
 * Data-only: NEVER writes formulas, hyperlinks, macros or external links
 * — values go in as strings with the text format ('@') unless the caller
 * opts a column into number/date parsing (preview shows original vs
 * parsed first). Precision: values >15 significant digits stay strings.
 */

export interface XlsxSheetInput {
  name: string;
  /** rows[r][c] — display text (editedText ?? rawText, header excluded by caller). */
  rows: string[][];
  /** Column parse hints; 'text' (default) keeps the text format. */
  colKinds?: ('text' | 'number' | 'date')[];
}

export interface XlsxResult {
  bytes: Uint8Array;
  /** Cells written as parsed numbers/dates (0 in default text mode). */
  parsedCells: number;
  /** Values whose precision >15 digits forced a string fallback. */
  precisionFallbacks: string[];
}

const MAX_PRECISION_DIGITS = 15;

function tryNumber(text: string): { ok: boolean; value: number; precisionRisk: boolean } {
  const t = text.trim();
  if (!/^[-+]?(\d+([.,]\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(t) || !/\d/.test(t)) {
    return { ok: false, value: NaN, precisionRisk: false };
  }
  const normalized = t.replace(',', '.');
  // Leading-zero IDs ("00123") are NOT numbers — exact text wins.
  if (/^[-+]?0\d/.test(normalized)) return { ok: false, value: NaN, precisionRisk: false };
  const value = Number(normalized);
  if (!Number.isFinite(value)) return { ok: false, value: NaN, precisionRisk: false };
  const digits = normalized.replace(/[-+.eE].*$/, '').replace(/^0+/, '').length;
  return { ok: true, value, precisionRisk: digits > MAX_PRECISION_DIGITS };
}

/** Only the UNAMBIGUOUS ISO form parses as a date; locale forms
 * (DD/MM vs MM/DD) stay exact text — ambiguity never becomes data. */
function tryDate(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime())
    ? null
    : d;
}

export async function buildXlsx(sheets: XlsxSheetInput[]): Promise<XlsxResult> {
  const { Workbook } = await import('exceljs');
  const wb = new Workbook();
  let parsedCells = 0;
  const precisionFallbacks: string[] = [];
  for (const input of sheets) {
    const ws = wb.addWorksheet(input.name.slice(0, 31) || 'Sheet');
    input.rows.forEach((row, r) => {
      const excelRow = ws.getRow(r + 1);
      row.forEach((text, c) => {
        const kind = input.colKinds?.[c] ?? 'text';
        if (r === 0 || kind === 'text') {
          excelRow.getCell(c + 1).value = text;
          excelRow.getCell(c + 1).numFmt = '@';
          return;
        }
        if (kind === 'date') {
          const d = tryDate(text);
          if (d) {
            excelRow.getCell(c + 1).value = d;
            parsedCells += 1;
            return;
          }
        }
        const n = tryNumber(text);
        if (n.ok && !n.precisionRisk) {
          excelRow.getCell(c + 1).value = n.value;
          parsedCells += 1;
          return;
        }
        if (n.ok && n.precisionRisk) precisionFallbacks.push(text);
        excelRow.getCell(c + 1).value = text;
        excelRow.getCell(c + 1).numFmt = '@';
      });
    });
  }
  const buffer = await wb.xlsx.writeBuffer();
  return { bytes: new Uint8Array(buffer as ArrayBuffer), parsedCells, precisionFallbacks };
}
