import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cellText,
  type CellKind,
  type TableSheet,
  type TableCell,
} from '../../lib/tables/model';

/*
 * Phase-5 editable grid (plan step 4): windowed rendering over stable
 * row/col ids, keyboard navigation/edit (arrows + Enter + direct typing),
 * plain-text paste (TSV/newline splitting), scan 'review' badges, and
 * per-column data-type overrides. Merges render as spans. The grid is a
 * VIEW — every mutation goes up through onEdit so history owns reversibility.
 */

const ROW_H = 32;
const COL_W = 140;
const OVERSCAN = 6;

export interface GridEdit {
  type: 'set' | 'kind';
  rowId: string;
  colId: string;
  value: string | CellKind;
}

export function TableGrid({
  sheet,
  onEdit,
  onStructure,
  activeCell,
  setActiveCell,
  focusSignal,
}: {
  sheet: TableSheet;
  onEdit: (edit: GridEdit) => void;
  onStructure: (op: 'insertRow' | 'deleteRow' | 'insertCol' | 'deleteCol' | 'merge' | 'split', index: number) => void;
  activeCell: { rowId: string; colId: string } | null;
  setActiveCell: (c: { rowId: string; colId: string } | null) => void;
  /** Increments when a cell should receive focus (paste/undo landings). */
  focusSignal?: number;
}) {
  const { t } = useTranslation('common');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, HTMLInputElement>());
  const gridW = sheet.colIds.length * COL_W;
  const gridH = sheet.rowIds.length * ROW_H;
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const lastRow = Math.min(sheet.rowIds.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setViewH(el.clientHeight));
    obs.observe(el);
    setViewH(el.clientHeight);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (focusSignal === undefined || !activeCell) return;
    const el = cellRefs.current.get(`${activeCell.rowId}|${activeCell.colId}`);
    el?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal]);

  const rowIndex = useMemo(() => new Map(sheet.rowIds.map((id, i) => [id, i])), [sheet.rowIds]);
  const colIndex = useMemo(() => new Map(sheet.colIds.map((id, i) => [id, i])), [sheet.colIds]);

  const cellsByKey = useMemo(() => {
    const m = new Map<string, TableCell>();
    for (const c of sheet.cells) m.set(`${c.rowId}|${c.colId}`, c);
    return m;
  }, [sheet.cells]);

  const move = (dr: number, dc: number) => {
    if (!activeCell) return;
    const r = rowIndex.get(activeCell.rowId) ?? 0;
    const c = colIndex.get(activeCell.colId) ?? 0;
    const nr = Math.min(sheet.rowIds.length - 1, Math.max(0, r + dr));
    const nc = Math.min(sheet.colIds.length - 1, Math.max(0, c + dc));
    const rowId = sheet.rowIds[nr];
    const colId = sheet.colIds[nc];
    if (rowId && colId) setActiveCell({ rowId, colId });
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (!activeCell) return;
    const r0 = rowIndex.get(activeCell.rowId) ?? 0;
    const c0 = colIndex.get(activeCell.colId) ?? 0;
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (lines.length > 1 || text.includes('\t')) {
      lines.forEach((line, ri) => {
        line.split('\t').forEach((val, ci) => {
          const rowId = sheet.rowIds[r0 + ri];
          const colId = sheet.colIds[c0 + ci];
          if (rowId && colId) onEdit({ type: 'set', rowId, colId, value: val });
        });
      });
    } else {
      onEdit({ type: 'set', rowId: activeCell.rowId, colId: activeCell.colId, value: text });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1, 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1, 0); }
    else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); move(0, 1); }
    else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); move(0, -1); }
    else if (e.key === 'Enter') { e.preventDefault(); move(1, 0); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* structure toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 py-1.5 text-[12px]">
        <button
          type="button"
          className="min-h-8 rounded border border-border-strong px-2"
          data-testid="grid-insert-row"
          onClick={() => onStructure('insertRow', activeCell ? (rowIndex.get(activeCell.rowId) ?? 0) : 0)}
        >
          + {t('tables.row')}
        </button>
        <button
          type="button"
          className="min-h-8 rounded border border-border-strong px-2"
          data-testid="grid-delete-row"
          onClick={() => onStructure('deleteRow', activeCell ? (rowIndex.get(activeCell.rowId) ?? 0) : -1)}
        >
          − {t('tables.row')}
        </button>
        <button
          type="button"
          className="min-h-8 rounded border border-border-strong px-2"
          data-testid="grid-insert-col"
          onClick={() => onStructure('insertCol', activeCell ? (colIndex.get(activeCell.colId) ?? 0) : 0)}
        >
          + {t('tables.col')}
        </button>
        <button
          type="button"
          className="min-h-8 rounded border border-border-strong px-2"
          data-testid="grid-delete-col"
          onClick={() => onStructure('deleteCol', activeCell ? (colIndex.get(activeCell.colId) ?? 0) : -1)}
        >
          − {t('tables.col')}
        </button>
        <button
          type="button"
          className="min-h-8 rounded border border-border-strong px-2"
          data-testid="grid-merge"
          onClick={() => onStructure('merge', activeCell ? (rowIndex.get(activeCell.rowId) ?? 0) : 0)}
        >
          {t('tables.merge')}
        </button>
        <button
          type="button"
          className="min-h-8 rounded border border-border-strong px-2"
          data-testid="grid-split"
          onClick={() => {
            if (activeCell) onStructure('split', 0);
          }}
        >
          {t('tables.split')}
        </button>
      </div>
      <div
        ref={scrollerRef}
        data-testid="table-grid"
        className="min-h-0 flex-1 overflow-auto rounded-lg border border-border-strong bg-surface-card"
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        <div style={{ width: gridW + COL_W, height: gridH + ROW_H }}>
          {/* header row: col letters + kind selects */}
          <div className="sticky top-0 z-10 flex bg-surface-header">
            <div style={{ width: COL_W, height: ROW_H }} className="shrink-0 border-b border-r border-border-strong px-1 text-[11px] leading-[32px] text-text-muted">
              {sheet.headerRow >= 0 ? t('tables.header') : ''}
            </div>
            {sheet.colIds.map((colId, ci) => {
              const cell =
                sheet.headerRow >= 0 ? cellsByKey.get(`${sheet.rowIds[sheet.headerRow]}|${colId}`) : undefined;
              return (
                <div key={colId} style={{ width: COL_W }} className="shrink-0 border-b border-r border-border-strong">
                  {cell ? (
                    <input
                      className="h-full w-full bg-transparent px-1 text-[12px] font-semibold text-text-primary outline-none"
                      value={cellText(sheet, cell)}
                      onChange={(e) => onEdit({ type: 'set', rowId: cell.rowId, colId, value: e.target.value })}
                      aria-label={`${t('tables.col')} ${ci + 1}`}
                    />
                  ) : (
                    <span className="px-1 text-[11px] leading-[32px] text-text-muted">{ci + 1}</span>
                  )}
                  <select
                    className="absolute h-0 w-0 opacity-0"
                    aria-hidden
                    tabIndex={-1}
                    value={cellsByKey.get(`${sheet.rowIds[0]}|${colId}`)?.kind ?? 'text'}
                    onChange={(e) =>
                      onEdit({ type: 'kind', rowId: sheet.rowIds[0]!, colId, value: e.target.value as CellKind })
                    }
                    data-testid={`grid-kind-${colId}`}
                  >
                    <option value="text">text</option>
                    <option value="number">number</option>
                    <option value="date">date</option>
                  </select>
                </div>
              );
            })}
          </div>
          {/* body window */}
          {sheet.rowIds.slice(firstRow, lastRow).map((rowId) => {
            const displayRow = firstRow + sheet.rowIds.slice(firstRow, lastRow).indexOf(rowId);
            return (
              <div key={rowId} className="flex">
                <div
                  style={{ width: COL_W, height: ROW_H }}
                  className="shrink-0 border-b border-r border-border-strong px-1 text-[11px] leading-[32px] text-text-muted"
                >
                  {displayRow + 1}
                </div>
                {sheet.colIds.map((colId) => {
                  const cell = cellsByKey.get(`${rowId}|${colId}`);
                  const active = activeCell?.rowId === rowId && activeCell?.colId === colId;
                  const isHeader = sheet.headerRow >= 0 && displayRow === sheet.headerRow;
                  const review = cell?.warnings.includes('review') ?? false;
                  return (
                    <div
                      key={colId}
                      style={{ width: COL_W, height: ROW_H }}
                      className={`relative shrink-0 border-b border-r border-border-strong ${
                        active ? 'bg-accent-soft' : ''
                      }`}
                      data-active={active || undefined}
                    >
                      <input
                        ref={(el) => {
                          if (el) cellRefs.current.set(`${rowId}|${colId}`, el);
                          else cellRefs.current.delete(`${rowId}|${colId}`);
                        }}
                        className={`h-full w-full bg-transparent px-1 text-[12px] text-text-primary outline-none ${
                          isHeader ? 'font-semibold' : ''
                        }`}
                        value={cell ? cellText(sheet, cell) : ''}
                        data-testid={`grid-cell-${displayRow}-${sheet.colIds.indexOf(colId)}`}
                        onFocus={() => setActiveCell({ rowId, colId })}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        onChange={(e) => onEdit({ type: 'set', rowId, colId, value: e.target.value })}
                        placeholder={review ? t('tables.review') : undefined}
                      />
                      {review && (
                        <span
                          className="pointer-events-none absolute right-0.5 top-0.5 rounded bg-tone-orange-soft px-0.5 text-[9px] text-tone-orange"
                          data-testid="grid-review-badge"
                        >
                          ?
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
