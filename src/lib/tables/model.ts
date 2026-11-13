/*
 * Phase-5 table document model (plan 261112-0955). A TableSheet holds
 * STABLE row/column ids (grid edits renumber positions, never ids, so
 * provenance and history survive insert/delete/merge). Cells carry
 * rawText (detector output, immutable) + editedText (null = raw) +
 * source provenance + optional span + manual data-type override.
 *
 * Confidence posture: confidence is present ONLY when a detector
 * supplied one — the pipeline has none, so it stays null everywhere
 * ("unknown when none", never invented). Scan-derived cells carry the
 * 'review' warning instead (unverified until a human confirms).
 *
 * Budgets are explicit (typed refusals, never silent truncation).
 * Pure lib: no React, no worker imports.
 */

import type { TableRegion } from './detect';

/** Cell-count ceiling: a hostile 20000-item page can grid-farm the tab. */
export const TABLE_CELL_BUDGET = 100_000;
/** History budget — same shape as the organizer's (explicit confirm on push
 * that would discard, never silent truncation). */
export const TABLE_HISTORY_BUDGET = 100;
/** Multi-page join preview cap (explicit join, never implicit). */
export const JOIN_PREVIEW_MAX_SHEETS = 20;

export type CellKind = 'text' | 'number' | 'date';

export interface TableCell {
  rowId: string;
  colId: string;
  /** Detector/scan/manual original text — immutable once created. */
  rawText: string;
  /** User edit; null = cell shows rawText. */
  editedText: string | null;
  /** Provenance (null for manually added cells). */
  sourcePage: number | null;
  regionIndex: number | null;
  /** Merge spans (reversible through history). */
  colSpan: number;
  rowSpan: number;
  /** Manual data-type override; default 'text' = emit as string. */
  kind: CellKind;
  /** Detector confidence; null = unknown — never a fabricated number. */
  confidence: number | null;
  /** 'review' = scan-derived (unverified); others free-form. */
  warnings: string[];
}

export interface TableSheet {
  id: string;
  /** Position-ordered stable ids. */
  rowIds: string[];
  colIds: string[];
  cells: TableCell[];
  /** Header row index (-1 = none). Header edits are normal cell edits. */
  headerRow: number;
  /** Provenance summary for the UI/report. */
  provenance: {
    sourcePages: number[];
    scan: boolean;
    warnings: string[];
  };
}

let idCounter = 0;
const nextId = (prefix: string) => {
  idCounter += 1;
  return `${prefix}${idCounter}`;
};

export class TableCellBudgetError extends Error {
  constructor(readonly cells: number) {
    super(`Table would exceed the ${TABLE_CELL_BUDGET} cell safety budget (${cells} cells)`);
    this.name = 'TableCellBudgetError';
  }
}

const cellAt = (sheet: TableSheet, rowId: string, colId: string): TableCell | undefined =>
  sheet.cells.find((c) => c.rowId === rowId && c.colId === colId);

/** Effective display text: editedText when set, else rawText. */
export function cellText(sheet: TableSheet, cell: TableCell): string {
  void sheet;
  return cell.editedText ?? cell.rawText;
}

/** Build a sheet from digital regions of ONE OR MORE pages (region order =
 * table order; one sheet per region unless explicitly joined). */
export function sheetFromRegions(regions: TableRegion[], scan = false): TableSheet {
  const rowCount = regions.reduce((m, r) => Math.max(m, r.rows.length), 0);
  const colCount = regions.reduce((m, r) => Math.max(m, ...r.rows.map((row) => row.length)), 0);
  const rowIds = Array.from({ length: rowCount }, () => nextId('r'));
  const colIds = Array.from({ length: colCount }, () => nextId('c'));
  const cells: TableCell[] = [];
  const occupied = new Set<string>();
  for (const [ri, region] of regions.entries()) {
    for (const [r, row] of region.rows.entries()) {
      for (const [c, text] of row.entries()) {
        const key = `${rowIds[r]!}|${colIds[c]!}`;
        if (occupied.has(key)) continue; // first region wins overlaps
        occupied.add(key);
        cells.push({
          rowId: rowIds[r]!,
          colId: colIds[c]!,
          rawText: text,
          editedText: null,
          sourcePage: region.sourcePage,
          regionIndex: ri,
          colSpan: 1,
          rowSpan: 1,
          kind: 'text',
          confidence: null,
          warnings: scan ? ['review'] : [...region.warnings],
        });
      }
    }
  }
  if (cells.length > TABLE_CELL_BUDGET) throw new TableCellBudgetError(cells.length);
  return {
    id: nextId('s'),
    rowIds,
    colIds,
    cells,
    headerRow: rowCount > 0 ? 0 : -1,
    provenance: {
      sourcePages: [...new Set(regions.map((r) => r.sourcePage))],
      scan,
      warnings: regions.flatMap((r) => r.warnings),
    },
  };
}

// ---------------------------------------------------------------------------
// Grid operations (all PURE: return a new sheet, no mutation — history
// snapshots whole sheets; at budget size a sheet is a few MB max).
// ---------------------------------------------------------------------------

export function setCellText(sheet: TableSheet, rowId: string, colId: string, text: string): TableSheet {
  const cells = sheet.cells.map((c) =>
    c.rowId === rowId && c.colId === colId
      ? { ...c, editedText: text === c.rawText ? null : text }
      : c,
  );
  return { ...sheet, cells };
}

export function setCellKind(sheet: TableSheet, rowId: string, colId: string, kind: CellKind): TableSheet {
  const cells = sheet.cells.map((c) =>
    c.rowId === rowId && c.colId === colId ? { ...c, kind } : c,
  );
  return { ...sheet, cells };
}

/** Ensure a cell exists (manual addition in an empty slot). */
export function ensureCell(sheet: TableSheet, rowId: string, colId: string): TableCell {
  const found = cellAt(sheet, rowId, colId);
  if (found) return found;
  const cell: TableCell = {
    rowId,
    colId,
    rawText: '',
    editedText: null,
    sourcePage: null,
    regionIndex: null,
    colSpan: 1,
    rowSpan: 1,
    kind: 'text',
    confidence: null,
    warnings: [],
  };
  return cell;
}

export function insertRow(sheet: TableSheet, afterRowIndex: number): TableSheet {
  const newRowId = nextId('r');
  const rowIds = [...sheet.rowIds];
  rowIds.splice(afterRowIndex + 1, 0, newRowId);
  const cells = [...sheet.cells];
  for (const colId of sheet.colIds) {
    cells.push({
      rowId: newRowId,
      colId,
      rawText: '',
      editedText: null,
      // Manual insertion carries NO source provenance — honesty.
      sourcePage: null,
      regionIndex: null,
      colSpan: 1,
      rowSpan: 1,
      kind: 'text',
      confidence: null,
      warnings: [],
    });
  }
  return { ...sheet, rowIds, cells };
}

export function deleteRows(sheet: TableSheet, rowIndexes: number[]): TableSheet {
  const kill = new Set(rowIndexes.map((i) => sheet.rowIds[i]));
  const rowIds = sheet.rowIds.filter((id) => !kill.has(id));
  const cells = sheet.cells.filter((c) => !kill.has(c.rowId));
  return { ...sheet, rowIds, cells };
}

export function insertCol(sheet: TableSheet, afterColIndex: number): TableSheet {
  const newColId = nextId('c');
  const colIds = [...sheet.colIds];
  colIds.splice(afterColIndex + 1, 0, newColId);
  const cells = [...sheet.cells];
  for (const rowId of sheet.rowIds) {
    cells.push({
      rowId,
      colId: newColId,
      rawText: '',
      editedText: null,
      // Manual insertion carries NO source provenance — honesty.
      sourcePage: null,
      regionIndex: null,
      colSpan: 1,
      rowSpan: 1,
      kind: 'text',
      confidence: null,
      warnings: [],
    });
  }
  return { ...sheet, colIds, cells };
}

export function deleteCols(sheet: TableSheet, colIndexes: number[]): TableSheet {
  const kill = new Set(colIndexes.map((i) => sheet.colIds[i]));
  const colIds = sheet.colIds.filter((id) => !kill.has(id));
  const cells = sheet.cells.filter((c) => !kill.has(c.colId));
  return { ...sheet, colIds, cells };
}

/** Merge a rectangular run into a colSpan/rowSpan on the anchor cell;
 * covered cells keep their data (split restores them — reversible). */
export function mergeCells(
  sheet: TableSheet,
  anchorRow: number,
  anchorCol: number,
  rowSpan: number,
  colSpan: number,
): TableSheet {
  const aRow = sheet.rowIds[anchorRow];
  const aCol = sheet.colIds[anchorCol];
  if (!aRow || !aCol) return sheet;
  const cells = sheet.cells.map((c) => {
    if (c.rowId === aRow && c.colId === aCol) return { ...c, rowSpan, colSpan };
    const rIdx = sheet.rowIds.indexOf(c.rowId);
    const cIdx = sheet.colIds.indexOf(c.colId);
    if (rIdx >= anchorRow && rIdx < anchorRow + rowSpan && cIdx >= anchorCol && cIdx < anchorCol + colSpan) {
      return { ...c, colSpan: 1, rowSpan: 1 };
    }
    return c;
  });
  return { ...sheet, cells };
}

/** Split a merged anchor back to spans of 1 (covered cells never lost). */
export function splitCell(sheet: TableSheet, rowId: string, colId: string): TableSheet {
  const cells = sheet.cells.map((c) =>
    c.rowId === rowId && c.colId === colId ? { ...c, rowSpan: 1, colSpan: 1 } : c,
  );
  return { ...sheet, cells };
}

export function setHeaderRow(sheet: TableSheet, index: number): TableSheet {
  return { ...sheet, headerRow: index };
}

// ---------------------------------------------------------------------------
// Multi-page join: EXPLICIT only (preview + header resolution decided by
// the caller). Sheets must share a column count.
// ---------------------------------------------------------------------------

export interface JoinPreview {
  ok: boolean;
  reason?: string;
  sheets: { id: string; rows: number; cols: number; header?: string[] }[];
  colCounts?: number[];
}

export function previewJoin(sheets: TableSheet[]): JoinPreview {
  if (sheets.length < 2 || sheets.length > JOIN_PREVIEW_MAX_SHEETS) {
    return { ok: false, reason: 'join_count', sheets: [] };
  }
  const colCounts = sheets.map((s) => s.colIds.length);
  const uniform = colCounts.every((n) => n === colCounts[0]);
  const meta = sheets.map((s) => ({
    id: s.id,
    rows: s.rowIds.length,
    cols: s.colIds.length,
    header:
      s.headerRow >= 0 && s.rowIds.length > 0
        ? s.colIds.map((c) => {
            const cell = s.cells.find(
              (x) => x.rowId === s.rowIds[s.headerRow] && x.colId === c,
            );
            return cell ? cellText(s, cell) : '';
          })
        : undefined,
  }));
  if (!uniform) return { ok: false, reason: 'join_cols', sheets: meta, colCounts };
  return { ok: true, sheets: meta };
}

/** Join: first sheet keeps its header; the rest lose theirs. */
export function joinSheets(sheets: TableSheet[]): TableSheet {
  const [first, ...rest] = sheets;
  if (!first) throw new Error('joinSheets needs at least one sheet');
  const rowIds: string[] = [];
  const cells: TableCell[] = [];
  const colIds = [...first.colIds];
  const pushSheet = (s: TableSheet, skipHeader: boolean) => {
    s.rowIds.forEach((rid, rIdx) => {
      if (skipHeader && rIdx === s.headerRow) return;
      const newRowId = nextId('r');
      rowIds.push(newRowId);
      for (const cid of s.colIds) {
        const src = cellAt(s, rid, cid);
        if (src) cells.push({ ...src, rowId: newRowId, colSpan: 1, rowSpan: 1 });
      }
    });
  };
  pushSheet(first, false);
  for (const s of rest) pushSheet(s, s.headerRow >= 0);
  return {
    id: nextId('s'),
    rowIds,
    colIds,
    cells,
    headerRow: first.headerRow,
    provenance: {
      sourcePages: [...new Set(sheets.flatMap((s) => s.provenance.sourcePages))],
      scan: sheets.some((s) => s.provenance.scan),
      warnings: sheets.flatMap((s) => s.provenance.warnings),
    },
  };
}
