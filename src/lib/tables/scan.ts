/*
 * Phase-5 scan path (plan 261112-0955 step 3): the AI seam supplies
 * Markdown ONLY — never trusted boxes or calibrated confidence. This
 * module parses the markdown table dialect the OCR path already emits
 * (the SAME split rules as ai-markdown: split on unescaped pipes,
 * unescape `\|` afterwards, separator rows skipped) into sheet cells
 * marked UNVERIFIED ('review' warning, confidence null).
 */

import { TABLE_CELL_BUDGET, TableCellBudgetError, type TableSheet } from './model';
import { sheetFromRegions } from './model';
import type { TableRegion } from './detect';

/** Parse ONE markdown table block (header + separator + body rows). */
export function markdownTableRows(block: string): string[][] | null {
  const lines = block.split('\n').map((l) => l.trimEnd());
  const rows: string[][] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!/^\|.+\|$/.test(line)) continue;
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replaceAll('\\|', '|'));
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // GFM separator
    rows.push(cells);
  }
  return rows.length >= 2 ? rows : null;
}

/** Build a review-required sheet from scan markdown. */
export function sheetFromScanMarkdown(block: string, sourcePage: number): TableSheet {
  const rows = markdownTableRows(block);
  if (!rows) throw new Error('No markdown table found in the scan output');
  const colCount = Math.max(...rows.map((r) => r.length));
  const region: TableRegion = {
    rows: rows.map((r) => {
      const padded = [...r];
      while (padded.length < colCount) padded.push('');
      return padded;
    }),
    bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
    sourcePage,
    warnings: ['scan_review'],
  };
  const cells = rows.length * colCount;
  if (cells > TABLE_CELL_BUDGET) throw new TableCellBudgetError(cells);
  return sheetFromRegions([region], true);
}
