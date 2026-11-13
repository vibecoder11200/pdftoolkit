import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { engine } from '../../engine/client';
import { getVisualTextItems, renderPageToCanvas } from '../../engine/pdfjs';
import { detectTableRegions, type RefusedRegion } from '../../lib/tables/detect';
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
  sheetFromRegions,
  splitCell,
  type CellKind,
  type TableSheet,
} from '../../lib/tables/model';
import { createTableHistory, pushTableSheet, redoTable, undoTable } from '../../lib/tables/history';
import { emitCsv } from '../../lib/tables/csv';
import { sheetFromScanMarkdown, markdownTableRows } from '../../lib/tables/scan';
import { useDelivery } from '../../lib/use-delivery';
import { engineErrorDetail } from '../../lib/engine-error';
import { beginJob, endJob } from '../../lib/jobs';
import { isTauri } from '../../lib/platform';
import type { RasterImageData } from '../../workers/pdf.worker';
import { AI_MODEL_ID } from '../../lib/ai-models';
import { downloadIfNeeded, runAiPages, type AiRunClient } from '../../lib/ai-run';
import { sharedAiClient } from '../../lib/ai-worker-client';
import { sharedNativeClient } from '../../lib/ai-native-client';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { checkPdfFile } from '../../lib/file-accept';
import { TableGrid, type GridEdit } from './table-grid';
import { DeliveryReportBar } from './delivery-report-bar';

/*
 * Phase-5 tables tool (tool #22): digital + scan table extraction into an
 * editable grid with safe CSV/XLSX delivery.
 *
 * Contracts honored:
 * - Digital detection reuses the pdf2word primitives (parity-tested).
 * - Scan runs the EXISTING AI seam unchanged (byte-locked prompt untouched);
 *   AI output is markdown only, cells land with 'review' warnings and
 *   confidence null (never invented).
 * - Rotated-text bands refused with a warning — no mislocated text.
 * - CSV safe default + explicit raw confirm; XLSX data-only in the worker
 *   (exceljs lazy); outputs ride the phase-3 delivery contract.
 */

interface SrcFile {
  bytes: Uint8Array;
  name: string;
  numPages: number;
}

const AI_DPI = 150;

export function TablesTool() {
  const { t } = useTranslation('common');
  const [src, setSrc] = useState<SrcFile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<TableSheet[]>([]);
  const [refused, setRefused] = useState<RefusedRegion[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [scanConfirmArmed, setScanConfirmArmed] = useState(false);
  const [scanPages, setScanPages] = useState<number[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [csvOpts, setCsvOpts] = useState<{ delimiter: ',' | ';' | '\t'; bom: boolean; raw: boolean }>({
    delimiter: ',',
    bom: true,
    raw: false,
  });
  const [rawConfirm, setRawConfirm] = useState(false);
  const [activeCell, setActiveCell] = useState<{ rowId: string; colId: string } | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const delivery = useDelivery();
  const historyRef = useRef(new Map<string, ReturnType<typeof createTableHistory>>());
  const [, setHistVersion] = useState(0);
  const srcRef = useRef<SrcFile | null>(null);
  srcRef.current = src;

  const active = sheets.find((s) => s.id === activeId) ?? null;
  const hist = active ? historyRef.current.get(active.id) : undefined;

  const applySheet = useCallback(
    (sheet: TableSheet, discardedRedo: number, evictedUndo: number) => {
      setSheets((prev) => prev.map((s) => (s.id === sheet.id ? sheet : s)));
      if (discardedRedo > 0 || evictedUndo > 0) {
        setRunError(
          t('tables.history_discard', { redo: discardedRedo, undo: evictedUndo }),
        );
      }
    },
    [t],
  );

  const editSheet = useCallback(
    (next: TableSheet) => {
      const h = historyRef.current.get(next.id);
      if (!h) return;
      const res = pushTableSheet(h, next);
      historyRef.current.set(next.id, res.history);
      applySheet(res.history.current, res.discardedRedo, res.evictedUndo);
      setHistVersion((v) => v + 1);
    },
    [applySheet],
  );

  const handleEdit = useCallback(
    (edit: GridEdit) => {
      if (!active) return;
      if (edit.type === 'set') {
        editSheet(setCellText(active, edit.rowId, edit.colId, String(edit.value)));
      } else {
        editSheet(setCellKind(active, edit.rowId, edit.colId, edit.value as CellKind));
      }
    },
    [active, editSheet],
  );

  const handleStructure = useCallback(
    (op: 'insertRow' | 'deleteRow' | 'insertCol' | 'deleteCol' | 'merge' | 'split', index: number) => {
      if (!active) return;
      const ci = activeCell ? active.colIds.indexOf(activeCell.colId) : 0;
      let next: TableSheet = active;
      if (op === 'insertRow') next = insertRow(active, index);
      else if (op === 'deleteRow') next = deleteRows(active, [index]);
      else if (op === 'insertCol') next = insertCol(active, index);
      else if (op === 'deleteCol') next = deleteCols(active, [index]);
      else if (op === 'merge') next = mergeCells(active, index, Math.max(0, ci), 2, 2);
      else if (op === 'split' && activeCell) next = splitCell(active, activeCell.rowId, activeCell.colId);
      if (next !== active) editSheet(next);
    },
    [active, activeCell, editSheet],
  );

  const reset = useCallback(() => {
    setSrc(null);
    setSheets([]);
    setRefused([]);
    setActiveId(null);
    setScanConfirmArmed(false);
    setScanPages([]);
    setScanning(false);
    setProgress(null);
    setRunError(null);
    setRawConfirm(false);
    setActiveCell(null);
    historyRef.current = new Map();
    delivery.clear();
  }, [delivery]);

  const addFiles = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      const gate = await checkPdfFile(file);
      if (!gate.ok) {
        setLoadError(t('tables.err_file', { name: file.name }));
        return;
      }
      setLoadError(null);
      setRunError(null);
      reset();
      try {
        beginJob('tables-intake');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { info } = await engine.loadPdf(bytes.slice(0));
        const numPages = info.numPages;
        if (numPages > 100) {
          setLoadError(t('tables.page_cap'));
          return;
        }
        setSrc({ bytes, name: file.name, numPages });
      } catch (e) {
        const d = engineErrorDetail(e, t('tables.err_load'), { title: t('tables.err_crash_title'), detail: t('tables.err_crash') }, () => setLoadError(null));
        setLoadError(typeof d === 'string' ? d : (d.detail ?? t('tables.err_load')));
      } finally {
        endJob('tables-intake');
      }
    },
    [reset, t],
  );

  /** Digital extraction + census → sheets. Runs on src change. */
  const extractAll = useCallback(async () => {
    const file = srcRef.current;
    if (!file) return;
    setRunError(null);
    setRefused([]);
    try {
      beginJob('tables-extract');
      const newSheets: TableSheet[] = [];
      const refusedAll: RefusedRegion[] = [];
      const scanPageList: number[] = [];
      for (let p = 1; p <= file.numPages; p += 1) {
        const items = await getVisualTextItems(file.bytes, p);
        const chars = items.reduce((m, i) => m + i.str.length, 0);
        if (chars < 32) {
          scanPageList.push(p);
          continue;
        }
        const { regions, refused } = detectTableRegions(items, p);
        refusedAll.push(...refused);
        for (const region of regions) {
          newSheets.push(sheetFromRegions([region]));
        }
      }
      if (refusedAll.length > 0) setRefused(refusedAll);
      setScanPages(scanPageList);
      if (newSheets.length > 0) {
        setSheets(newSheets);
        setActiveId(newSheets[0]!.id);
        for (const s of newSheets) {
          historyRef.current.set(s.id, createTableHistory(s));
        }
      } else if (scanPageList.length === 0) {
        setRunError(t('tables.none_found'));
      }
    } catch (e) {
      const d = engineErrorDetail(e, t('tables.err_run'), { title: t('tables.err_crash_title'), detail: t('tables.err_crash') }, () => void extractRef.current());
      setRunError(typeof d === 'string' ? d : (d.detail ?? t('tables.err_run')));
    } finally {
      endJob('tables-extract');
    }
  }, [t]);

  // Extraction effect keyed on src (extractAll reads through the ref so a
  // locale re-render never re-runs the whole extraction).
  const extractRef = useRef(extractAll);
  extractRef.current = extractAll;
  useEffect(() => {
    if (src) void extractRef.current();
  }, [src]);

  /** Scan pages: the EXISTING AI seam (same wiring as pdf-to-word; the
   * byte-locked prompt is untouched). Output markdown parses to review
   * cells. */
  const runScan = useCallback(async () => {
    const file = srcRef.current;
    if (!file || scanPages.length === 0) return;
    setScanning(true);
    setRunError(null);
    try {
      beginJob('tables-scan');
      const mocked =
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).has('ai-mock');
      const client: AiRunClient = isTauri()
        ? (sharedNativeClient() as AiRunClient)
        : sharedAiClient({ mock: mocked });
      const canvas = document.createElement('canvas');
      const scale = AI_DPI / 72;
      const renderPage = async (page: number): Promise<RasterImageData> => {
        await renderPageToCanvas(file.bytes, page, canvas, scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d context unavailable');
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (isTauri()) {
          const raster = { data: image.data, width: image.width, height: image.height } as RasterImageData & { dataUrl?: string };
          raster.dataUrl = canvas.toDataURL('image/png');
          return raster;
        }
        return { data: image.data, width: image.width, height: image.height };
      };
      await downloadIfNeeded(client, AI_MODEL_ID, (p) => {
        setProgress({
          value: 30,
          label: p.percent != null
            ? t('tables.ai_downloading', { percent: Math.round(p.percent) })
            : t('tables.ai_downloading_started'),
        });
      });
      const out = await runAiPages(
        client,
        file.numPages,
        renderPage,
        {
          onPage: (c, total) => {
            setProgress({
              value: 30 + Math.round((c / Math.max(1, total)) * 60),
              label: t('tables.ai_running', { current: c, total }),
            });
          },
        },
        { pages: [...scanPages].sort((a, b) => a - b) },
      );
      if (!out.completedAll) throw new Error('aborted');
      const sorted = out.results.slice().sort((a, b) => a.page - b.page);
      const scanSheets: TableSheet[] = [];
      for (const r of sorted) {
        const rows = markdownTableRows(r.text);
        if (!rows) continue; // page had no table — honest skip
        scanSheets.push(sheetFromScanMarkdown(r.text, r.page));
      }
      if (scanSheets.length > 0) {
        setSheets((prev) => [...prev, ...scanSheets]);
        setActiveId(scanSheets[0]!.id);
        for (const s of scanSheets) historyRef.current.set(s.id, createTableHistory(s));
        setScanConfirmArmed(false);
        setProgress(null);
      } else {
        setRunError(t('tables.none_found'));
      }
    } catch (e) {
      const d = engineErrorDetail(e, t('tables.err_run'), { title: t('tables.err_crash_title'), detail: t('tables.err_crash') }, () => void runScan());
      setRunError(typeof d === 'string' ? d : (d.detail ?? t('tables.err_run')));
    } finally {
      setScanning(false);
      endJob('tables-scan');
    }
  }, [scanPages, t]);

  const buildRowsForExport = useCallback(
    (sheet: TableSheet): string[][] => {
      ensureCell(sheet, sheet.rowIds[0]!, sheet.colIds[0]!);
      return sheet.rowIds.map((rid) =>
        sheet.colIds.map((cid) => {
          const c = sheet.cells.find((x) => x.rowId === rid && x.colId === cid);
          return c ? cellText(sheet, c) : '';
        }),
      );
    },
    [],
  );

  const exportCsv = useCallback(async () => {
    if (!active) return;
    if (csvOpts.raw && !rawConfirm) {
      setRawConfirm(true);
      return;
    }
    setRunError(null);
    try {
      beginJob('tables-export-csv');
      const rows = buildRowsForExport(active);
      const result = emitCsv(rows, {
        delimiter: csvOpts.delimiter,
        bom: csvOpts.bom,
        safe: !csvOpts.raw,
        quoteAll: true,
      });
      const stem = srcRef.current?.name?.replace(/\.pdf$/i, '') || 'table';
      const report = await delivery.deliver(
        [
          {
            filename: `${stem}.csv`,
            bytes: result.bytes,
          },
        ],
        'text/csv',
      );
      if (result.transformedCells > 0) {
        setRunError(t('tables.csv_transformed', { n: result.transformedCells }));
      }
      void report;
    } catch (e) {
      const d = engineErrorDetail(e, t('tables.err_run'), { title: t('tables.err_crash_title'), detail: t('tables.err_crash') }, () => void exportCsv());
      setRunError(typeof d === 'string' ? d : (d.detail ?? t('tables.err_run')));
    } finally {
      endJob('tables-export-csv');
    }
  }, [active, buildRowsForExport, csvOpts, delivery, rawConfirm, t]);

  const exportXlsx = useCallback(async () => {
    if (sheets.length === 0) return;
    setRunError(null);
    try {
      beginJob('tables-export-xlsx');
      const inputs = sheets.map((s, i) => ({
        name: t('tables.sheet_name', { n: i + 1 }),
        rows: buildRowsForExport(s),
        colKinds: s.colIds.map((cid) => {
          const probe = s.cells.find((c) => c.colId === cid);
          return (probe?.kind ?? 'text') as 'text' | 'number' | 'date';
        }),
      }));
      const { bytes, parsedCells, precisionFallbacks } = await engine.tablesExportXlsx(inputs);
      const stem = srcRef.current?.name?.replace(/\.pdf$/i, '') || 'tables';
      const report = await delivery.deliver(
        [
          {
            filename: `${stem}.xlsx`,
            bytes,
          },
        ],
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      if (precisionFallbacks.length > 0) {
        setRunError(t('tables.precision_note', { n: precisionFallbacks.length }));
      }
      void parsedCells;
      void report;
    } catch (e) {
      const d = engineErrorDetail(e, t('tables.err_run'), { title: t('tables.err_crash_title'), detail: t('tables.err_crash') }, () => void exportXlsx());
      setRunError(typeof d === 'string' ? d : (d.detail ?? t('tables.err_run')));
    } finally {
      endJob('tables-export-xlsx');
    }
  }, [buildRowsForExport, delivery, sheets, t]);

  const joinPreviewData = sheets.length >= 2 ? previewJoin(sheets) : null;
  const [joinArmed, setJoinArmed] = useState(false);

  const doUndo = useCallback(() => {
    const h = active ? historyRef.current.get(active.id) : undefined;
    if (!h) return;
    const u = undoTable(h);
    if (u.ok) {
      historyRef.current.set(active!.id, u.history);
      applySheet(u.history.current, 0, 0);
      setHistVersion((v) => v + 1);
      setFocusSignal((v) => v + 1);
    }
  }, [active, applySheet]);

  const doRedo = useCallback(() => {
    const h = active ? historyRef.current.get(active.id) : undefined;
    if (!h) return;
    const r = redoTable(h);
    if (r.ok) {
      historyRef.current.set(active!.id, r.history);
      applySheet(r.history.current, 0, 0);
      setHistVersion((v) => v + 1);
      setFocusSignal((v) => v + 1);
    }
  }, [active, applySheet]);

  const doJoin = useCallback(() => {
    if (!joinPreviewData?.ok) return;
    const ordered = sheets.filter((s) => joinPreviewData.sheets.some((m) => m.id === s.id));
    const joined = joinSheets(ordered);
    const others = sheets.filter((s) => !ordered.some((o) => o.id === s.id));
    const next = [...others, joined];
    setSheets(next);
    setActiveId(joined.id);
    historyRef.current = new Map(
      next.map((s) => [s.id, historyRef.current.get(s.id) ?? createTableHistory(s)]),
    );
    setJoinArmed(false);
  }, [joinPreviewData, sheets]);

  if (!src) {
    return (
      <WorkspaceShell
        title={t('tables.title')}
        error={loadError}
        steps={[{ key: 'pick', label: t('steps.pick'), state: 'now' }]}
        side={<p className="text-[13px] text-text-muted">{t('tables.intro')}</p>}
      >
        <Dropzone
          onFiles={(files) => void addFiles(files)}
          accept=".pdf"
          title={t('tables.drop')}
          hint={t('tables.intro')}
        />
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell
      title={t('tables.title')}
      error={loadError ?? runError}
      steps={[
        { key: 'load', label: t('tables.step_load'), state: 'done' },
        { key: 'edit', label: t('tables.step_edit'), state: 'now' },
        { key: 'download', label: t('steps.download'), state: 'todo' },
      ]}
      side={
        <div className="flex flex-col gap-2 text-[13px]">
          <p className="font-semibold">{t('tables.sheets')}</p>
          <ul className="flex flex-col gap-1" data-testid="tables-sheet-list">
            {sheets.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`min-h-8 w-full rounded border px-2 py-1 text-left ${
                    s.id === activeId ? 'border-accent bg-accent-soft font-semibold' : 'border-border-strong'
                  }`}
                  data-testid={`tables-sheet-${i}`}
                  onClick={() => {
                    setActiveId(s.id);
                    setActiveCell(null);
                  }}
                >
                  {t('tables.sheet_name', { n: i + 1 })}
                  <span className="ml-1 text-text-muted">
                    {s.rowIds.length}×{s.colIds.length}
                    {s.provenance.scan ? ' · ' + t('tables.scan_tag') : ''}
                  </span>
                </button>
                {s.provenance.warnings.includes('scan_review') && (
                  <span className="text-[11px] text-tone-orange">{t('tables.review')}</span>
                )}
              </li>
            ))}
          </ul>
          {refused.length > 0 && (
            <p className="text-[12px] text-tone-orange" data-testid="tables-rotated-note">
              {t('tables.rotated_refused', { n: refused.length })}
            </p>
          )}
          {scanPages.length > 0 && !scanConfirmArmed && !scanning && (
            <Button variant="secondary" data-testid="tables-scan-arm" onClick={() => setScanConfirmArmed(true)}>
              {t('tables.scan_arm', { n: scanPages.length })}
            </Button>
          )}
          {scanConfirmArmed && (
            <div className="rounded border border-border-strong p-2">
              <p className="text-[12px]">{t('tables.scan_confirm', { n: scanPages.length })}</p>
              <div className="mt-1 flex gap-1">
                <Button data-testid="tables-scan-run" disabled={scanning} onClick={() => void runScan()}>
                  {scanning ? t('tables.scan_running') : t('tables.scan_run')}
                </Button>
                <Button variant="secondary" onClick={() => setScanConfirmArmed(false)}>
                  {t('cancel')}
                </Button>
              </div>
              {progress ? (
                <p className="mt-1 text-[12px] text-text-muted" data-testid="tables-progress">
                  {progress.label}
                </p>
              ) : null}
            </div>
          )}
        </div>
      }
    >
      {delivery.report && (
        <DeliveryReportBar report={delivery.report} onRetry={delivery.retry} onDismiss={delivery.dismiss} busy={scanning} />
      )}
      {active ? (
        <TableGrid
          sheet={active}
          onEdit={handleEdit}
          onStructure={handleStructure}
          activeCell={activeCell}
          setActiveCell={setActiveCell}
          focusSignal={focusSignal}
        />
      ) : (
        <p className="text-[13px] text-text-muted">{t('tables.none_found')}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 py-1.5 text-[12px]">
        <Button variant="secondary" data-testid="tables-undo" onClick={doUndo} disabled={!hist}>
          {t('tables.undo')}
        </Button>
        <Button variant="secondary" data-testid="tables-redo" onClick={doRedo} disabled={!hist}>
          {t('tables.redo')}
        </Button>
        {sheets.length >= 2 && (
          <Button variant="secondary" data-testid="tables-join" onClick={() => setJoinArmed(true)}>
            {t('tables.join')}
          </Button>
        )}
        {joinArmed && joinPreviewData?.ok && (
          <div className="rounded border border-border-strong p-2 text-[12px]" data-testid="tables-join-preview">
            <p>{t('tables.join_rows', { n: joinPreviewData.sheets.reduce((m, s) => m + s.rows - (s.header !== undefined ? 1 : 0), 0) })}</p>
            <Button data-testid="tables-join-confirm" onClick={doJoin}>
              {t('tables.join_confirm')}
            </Button>
            <Button variant="secondary" onClick={() => setJoinArmed(false)}>
              {t('cancel')}
            </Button>
          </div>
          
        )}
        <span className="mx-1 h-5 w-px bg-border-strong" />
        <label className="flex items-center gap-1">
          {t('tables.delimiter')}
          <select
            className="min-h-8 rounded border border-border-strong bg-surface-card px-1"
            data-testid="tables-csv-delimiter"
            value={csvOpts.delimiter}
            onChange={(e) => setCsvOpts({ ...csvOpts, delimiter: e.target.value as ',' | ';' | '\t' })}
          >
            <option value=",">,</option>
            <option value=";">;</option>
            
          </select>
        </label>
        <label className="flex options gap-1">
          <input
            type="checkbox"
            checked={csvOpts.bom}
            onChange={(e) => setCsvOpts({ ...csvOpts, bom: e.target.checked })}
          />
          {t('tables.bom')}
        </label>
        <Button variant="secondary" data-testid="tables-export-csv" onClick={() => void exportCsv()}>
          {t('tables.export_csv')}
        </Button>
        {rawConfirm && (
          <span className="text-tone-orange" data-testid="tables-raw-warning">
            {t('tables.raw_warning')}
          </span>
        )}
        <Button data-testid="tables-export-xlsx" onClick={() => void exportXlsx()} disabled={sheets.length === 0}>
          {t('tables.export_xlsx')}
        </Button>
      </div>
    </WorkspaceShell>
  );
}
