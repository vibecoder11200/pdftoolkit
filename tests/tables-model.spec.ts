import { describe, expect, it } from 'vitest';

import type { TableRegion } from '../src/lib/tables/detect';
import {
  cellText,
  deleteCols,
  deleteRows,
  ensureCell,
  insertCol,
  insertRow,
  joinSheets,
  mergeCells,
  previewJoin,
  setCellKind,
  setCellText,
  setHeaderRow,
  sheetFromRegions,
  splitCell,
  TABLE_CELL_BUDGET,
  TableCellBudgetError,
} from '../src/lib/tables/model';
import {
  createTableHistory,
  pushTableSheet,
  redoTable,
  undoTable,
} from '../src/lib/tables/history';

const region = (rows: string[][], page = 1): TableRegion => ({
  rows,
  bbox: { x0: 0, y0: 0, x1: 100, y1: 100 },
  sourcePage: page,
  warnings: [],
});

describe('tables model — grid ops on stable ids', () => {
  it('sheetFromRegions: cells carry rawText + provenance + region index', () => {
    const sheet = sheetFromRegions([region([['H1', 'H2'], ['a', 'b']], 2)]);
    expect(sheet.rowIds).toHaveLength(2);
    expect(sheet.colIds).toHaveLength(2);
    const h = sheet.cells[0]!;
    expect(h.rawText).toBe('H1');
    expect(h.sourcePage).toBe(2);
    expect(h.regionIndex).toBe(0);
    expect(h.editedText).toBeNull();
    expect(h.confidence).toBeNull(); // unknown, never invented
    expect(sheet.headerRow).toBe(0);
  });

  it('setCellText: edit roundtrips to raw when reverted', () => {
    const sheet = sheetFromRegions([region([['a', 'b']])]);
    const [c] = sheet.cells;
    const edited = setCellText(sheet, c!.rowId, c!.colId, 'z');
    expect(cellText(edited, edited.cells[0]!)).toBe('z');
    const reverted = setCellText(edited, c!.rowId, c!.colId, 'a');
    expect(reverted.cells[0]!.editedText).toBeNull();
  });

  it('insert/delete row+col preserve all other stable ids', () => {
    const sheet = sheetFromRegions([region([['a', 'b'], ['c', 'd']])]);
    const before = { rows: [...sheet.rowIds], cols: [...sheet.colIds] };
    const withRow = insertRow(sheet, 0);
    expect(withRow.rowIds).toHaveLength(3);
    expect(withRow.rowIds).toContain(before.rows[0]);
    expect(withRow.rowIds).toContain(before.rows[1]);
    const afterDel = deleteRows(withRow, [1]);
    expect(afterDel.rowIds).toEqual([withRow.rowIds[0], before.rows[1]]);
    const withCol = insertCol(sheet, 1);
    expect(withCol.colIds).toHaveLength(3);
    const afterDelCol = deleteCols(withCol, [0]);
    expect(afterDelCol.colIds).toEqual([withCol.colIds[1], withCol.colIds[2]]);
  });

  it('merge/split reversible; covered cells keep data', () => {
    const sheet = sheetFromRegions([region([['a', 'b'], ['c', 'd']])]);
    const [a, b, c, d] = sheet.cells;
    const merged = mergeCells(sheet, 0, 0, 2, 2);
    const [ma] = merged.cells;
    expect(ma!.rowSpan).toBe(2);
    expect(ma!.colSpan).toBe(2);
    // covered cells still exist with their data
    expect(merged.cells).toHaveLength(4);
    expect(merged.cells.find((x) => x.rowId === d!.rowId && x.colId === d!.colId)!.rawText).toBe('d');
    const split = splitCell(merged, a!.rowId, a!.colId);
    expect(split.cells.every((x) => x.colSpan === 1 && x.rowSpan === 1)).toBe(true);
    // data survived the merge/split roundtrip
    expect(split.cells.map((x) => x.rawText).sort()).toEqual(['a', 'b', 'c', 'd']);
    void b; void c;
  });

  it('header edits are normal cell edits; setHeaderRow moves the marker', () => {
    const sheet = sheetFromRegions([region([['Old'], ['x']])]);
    const h = sheet.cells[0]!;
    const edited = setCellText(sheet, h.rowId, h.colId, 'New');
    expect(cellText(edited, edited.cells[0]!)).toBe('New');
    expect(setHeaderRow(edited, 1).headerRow).toBe(1);
  });

  it('kind override stored per cell', () => {
    const sheet = sheetFromRegions([region([['1'], ['2']])]);
    const [c0, c1] = sheet.cells;
    const withKind = setCellKind(sheet, c1!.rowId, c1!.colId, 'number');
    expect(withKind.cells.find((x) => x.rowId === c1!.rowId)!.kind).toBe('number');
    expect(withKind.cells.find((x) => x.rowId === c0!.rowId)!.kind).toBe('text');
  });

  it('manual cell in an empty slot carries NO provenance', () => {
    const sheet = sheetFromRegions([region([['a', 'b']])]);
    const withRow = insertRow(sheet, 0);
    const newRid = withRow.rowIds.find((id) => !sheet.rowIds.includes(id))!;
    const c = ensureCell(withRow, newRid, withRow.colIds[0]!);
    expect(c.rawText).toBe('');
    expect(c.sourcePage).toBeNull();
    // existing slot returns the existing cell untouched
    const existing = ensureCell(withRow, sheet.rowIds[0]!, sheet.colIds[1]!);
    expect(existing.rawText).toBe('b');
  });

  it('cell budget: over-budget extraction throws the typed error', () => {
    const big: TableRegion = {
      rows: Array.from({ length: 400 }, () => Array(400).fill('x')),
      bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
      sourcePage: 1,
      warnings: [],
    };
    expect(() => sheetFromRegions([big])).toThrow(TableCellBudgetError);
    expect(TABLE_CELL_BUDGET).toBe(100_000);
  });
});

describe('multi-page join — explicit only, schema-resolved', () => {
  it('preview rejects column mismatch with detail', () => {
    const a = sheetFromRegions([region([['H1', 'H2'], ['a', 'b']])]);
    const b = sheetFromRegions([region([['H1', 'H2', 'H3'], ['x', 'y', 'z']], 2)]);
    const p = previewJoin([a, b]);
    expect(p.ok).toBe(false);
    expect(p.reason).toBe('join_cols');
    expect(p.colCounts).toEqual([2, 3]);
  });

  it('preview exposes headers; join keeps FIRST header, drops the rest', () => {
    const a = sheetFromRegions([region([['ID', 'Name'], ['1', 'Ann']])]);
    const b = sheetFromRegions([region([['ID', 'Name'], ['2', 'Bob']], 2)]);
    const pv = previewJoin([a, b]);
    expect(pv.ok).toBe(true);
    expect(pv.sheets[0]!.header).toEqual(['ID', 'Name']);
    const joined = joinSheets([a, b]);
    expect(joined.rowIds).toHaveLength(3); // 2 + 1 (header dropped)
    expect(joined.provenance.sourcePages).toEqual([1, 2]);
    const headerCells = joined.rowIds[joined.headerRow]!;
    expect(
      joined.cells
        .filter((c) => c.rowId === headerCells)
        .map((c) => cellText(joined, c)),
    ).toEqual(['ID', 'Name']);
    // body row from b survived with provenance
    const body = joined.cells.find((c) => c.rawText === 'Bob');
    expect(body!.sourcePage).toBe(2);
  });
});

describe('table history — budget + inversion', () => {
  const base = sheetFromRegions([region([['a', 'b'], ['c', 'd']])]);

  it('undo/redo restores the exact sheet snapshot', () => {
    let h = createTableHistory(base);
    const edited = setCellText(h.current, base.cells[0]!.rowId, base.cells[0]!.colId, 'zz');
    h = pushTableSheet(h, edited).history;
    expect(h.past).toHaveLength(1);
    const u = undoTable(h);
    expect(u.ok).toBe(true);
    expect(u.history.current).toBe(base);
    const r = redoTable(u.history);
    expect(r.ok).toBe(true);
    expect(r.history.current).toBe(edited);
  });

  it('push after undo flags discardedRedo, never silently rewrites', () => {
    let h = createTableHistory(base);
    h = pushTableSheet(h, setCellText(h.current, base.cells[0]!.rowId, base.cells[0]!.colId, '1')).history;
    h = undoTable(h).history;
    const res = pushTableSheet(h, base);
    expect(res.discardedRedo).toBe(1);
  });

  it('budget: oldest undo entries evicted with explicit evictedUndo count', () => {
    let h = createTableHistory(base, 3);
    let evicted = 0;
    for (let i = 0; i < 5; i += 1) {
      const res = pushTableSheet(h, setCellText(h.current, base.cells[0]!.rowId, base.cells[0]!.colId, `v`));
      h = res.history;
      evicted += res.evictedUndo;
    }
    expect(h.past).toHaveLength(3);
    expect(evicted).toBe(2);
  });
});

