import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deliverBytes } from '../../lib/download';
import {
  groupRuns,
  runEditTextPipeline,
  type EditRunMark,
} from '../../lib/edit-text-pipeline';
import { CanvasFrame, usePageCanvas } from './editor-canvas';
import { ContinueChip } from './continue-chip';
import { useLastOutput } from '../../hooks/use-last-output';
import { Button } from '../ui/button';
import { ErrorBanner, type ErrorDetail } from '../ui/error-banner';
import { isEngineCrashedError } from '../../lib/engine-error';

/*
 * Edit-text tab (v0.9.0 phase 6 — M3a): click a text run on the positional
 * layer → the edit list; Apply = ONE runEditTextPipeline call (engine op +
 * run-scoped semantic verify, the single composer). Honest-copy contract:
 * the original run is REMOVED and covered white; the replacement is drawn
 * with the in-tree Roboto — the original font is NOT preserved (M3b is an
 * explicit stretch and not part of this release).
 */

export interface EditTextState {
  runs: { id: string; nx: number; nyTop: number; nw: number; nh: number; text: string }[];
  edits: EditRunMark[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRemoveEdit: (id: string) => void;
  onReplacementChange: (id: string, value: string) => void;
  onUndo: () => void;
  canUndo: boolean;
  runApply: () => void;
  busy: boolean;
  progress: string | null;
  lastOutput: { bytes: Uint8Array; filename: string } | null;
  error: string | ErrorDetail | null;
  fileName: string;
}

export function useEditTextState(bytes: Uint8Array, fileName: string, page: number): EditTextState {
  const { t } = useTranslation('common');
  const [allRuns, setAllRuns] = useState<Map<number, { nx: number; nyTop: number; nw: number; nh: number; text: string; fontSize: number; baselineTop: number }[]>>(new Map());
  const [edits, setEdits] = useState<EditRunMark[]>([]);
  const [history, setHistory] = useState<EditRunMark[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | ErrorDetail | null>(null);
  const { lastOutput, keep } = useLastOutput();
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const sizesRef = useRef(new Map<number, { width: number; height: number }>());

  // Load the positional runs of the current page (lazily, once per page).
  // A FAILURE is never cached (an entry for a failed/empty load would block
  // the real one), and stale completions are dropped via the generation
  // ref — never a shared boolean flag (a stale attempt would leave it set
  // forever and block every later load).
  const loadGen = useRef(0);
  useEffect(() => {
    if (allRuns.has(page)) return;
    const gen = (loadGen.current += 1);
    void (async () => {
      try {
        const { getPageTextItems, getPageVisualSize } = await import('../../engine/pdfjs');
        const { width: vw, height: vh } = await getPageVisualSize(bytes, page);
        if (loadGen.current !== gen) return;
        sizesRef.current.set(page, { width: vw, height: vh });
        const items = await getPageTextItems(bytes, page);
        if (loadGen.current !== gen) return;
        const grouped = groupRuns(items, vw, vh).map((r) => ({
          nx: r.nx,
          nyTop: r.nyTop,
          nw: r.nw,
          nh: r.nh,
          text: r.text,
          fontSize: r.fontSize,
          baselineTop: r.nyBaselineTop,
        }));
        setAllRuns((prev) => new Map(prev).set(page, grouped));
      } catch {
        /* leave the page ABSENT — the guard retries when bytes change */
      }
    })();
  }, [bytes, page, allRuns]);

  const pushHistory = useCallback((prev: EditRunMark[]) => {
    setHistory((h) => [...h.slice(-49), prev]);
  }, []);

  const onSelect = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (id === null) return;
      // Clicking a run that is not yet in the edit list adds it (white-out
      // by default; the replacement text is typed in the list).
      const exists = editsRef.current.some((e) => e.id === id);
      if (exists) return;
      const pageRuns = allRuns.get(page) ?? [];
      const run = pageRuns.find((_, i) => `run-${page}-${i}` === id);
      if (!run) return;
      pushHistory(editsRef.current);
      setEdits((prev) => [
        ...prev,
        {
          id,
          page,
          nx: run.nx,
          nyTop: run.nyTop,
          nw: run.nw,
          nh: run.nh,
          nyBaselineTop: run.baselineTop,
          text: run.text,
          replacement: '',
          fontSize: run.fontSize,
        },
      ]);
    },
    [allRuns, page, pushHistory],
  );

  const onRemoveEdit = useCallback(
    (id: string) => {
      pushHistory(editsRef.current);
      setEdits((prev) => prev.filter((e) => e.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [pushHistory],
  );

  const onReplacementChange = useCallback((id: string, value: string) => {
    setEdits((prev) => prev.map((e) => (e.id === id ? { ...e, replacement: value } : e)));
  }, []);

  const onUndo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      setEdits(h[h.length - 1]!);
      return h.slice(0, -1);
    });
  }, []);

  const runApply = useCallback(() => {
    if (busy) return;
    setError(null);
    setBusy(true);
    setProgress(t('editor.progress_working'));
    void (async () => {
      try {
        const out = await runEditTextPipeline(bytes, editsRef.current, sizesRef.current);
        const base = fileName.replace(/\.pdf$/i, '');
        const name = `${base}-edited.pdf`;
        if (await deliverBytes(out, name, 'download')) {
          keep(out, name);
          setProgress(t('editor.progress_done'));
        } else {
          setProgress(null);
        }
      } catch (e) {
        setProgress(null);
        if (isEngineCrashedError(e)) {
          setError({
            title: t('editor.err_crashed'),
            detail: t('editor.err_crashed_detail'),
            onRetry: () => runApply(),
          });
          return;
        }
        const name = e instanceof Error ? e.name : '';
        if (name === 'EditTextRefusedError' || name === 'EditTextVerifyError' || name === 'AnnotationRefusedError') {
          setError(t('editor.edit_refused', { message: e instanceof Error ? e.message : String(e) }));
          return;
        }
        setError(t('editor.err_failed', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, bytes, fileName, keep, t]);

  useEffect(() => {
    // File identity changed upstream → drop per-file state (mirrors the
    // redact tab's reset contract).
    setEdits([]);
    setHistory([]);
    setAllRuns(new Map());
    setSelectedId(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  const runs = (allRuns.get(page) ?? []).map((r, i) => ({
    id: `run-${page}-${i}`,
    nx: r.nx,
    nyTop: r.nyTop,
    nw: r.nw,
    nh: r.nh,
    text: r.text,
  }));

  return {
    runs,
    edits,
    selectedId,
    onSelect,
    onRemoveEdit,
    onReplacementChange,
    onUndo,
    canUndo: history.length > 0,
    runApply,
    busy,
    progress,
    lastOutput,
    error,
    fileName,
  };
}

/** The page canvas + click-to-select run overlay (main column). */
export function EditTextArea({
  bytes,
  page,
  version,
  state,
}: {
  bytes: Uint8Array;
  page: number;
  version: number | string;
  state: EditTextState;
}) {
  const { wrapRef, canvasRef, overlayRef, width } = usePageCanvas(bytes, page, version);
  return (
    <CanvasFrame
      wrapRef={wrapRef}
      canvasRef={canvasRef}
      width={width}
      overlayRef={overlayRef}
      disabled={false}
      onPointerDown={() => undefined}
      onPointerMove={() => undefined}
      onPointerUp={() => undefined}
      testid="edit-overlay"
    >
      {state.runs.map((r) => {
        const edited = state.edits.some((e) => e.id === r.id);
        const selected = state.selectedId === r.id;
        return (
          <button
            key={r.id}
            type="button"
            aria-label={`run-${r.id}`}
            title={r.text}
            onClick={() => state.onSelect(selected ? null : r.id)}
            className={`absolute rounded-[2px] ${
              edited
                ? 'border-2 border-solid border-accent bg-accent/25'
                : selected
                  ? 'border-2 border-solid border-amber-500 bg-amber-400/30'
                  : 'border border-dashed border-sky-500/60 hover:bg-sky-400/20'
            }`}
            style={{
              left: `${r.nx * 100}%`,
              top: `${r.nyTop * 100}%`,
              width: `${r.nw * 100}%`,
              height: `${r.nh * 100}%`,
              cursor: 'pointer',
            }}
          />
        );
      })}
    </CanvasFrame>
  );
}

/** Edit list + honest copy + apply (side panel). */
export function EditTextControls({ state }: { state: EditTextState }) {
  const { t } = useTranslation('common');
  const applyDisabled = state.busy || state.edits.length === 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-lg border border-border-default bg-surface-card p-2.5 text-[12.5px] leading-relaxed text-text-muted">
        {t('editor.edit_note')}
      </p>
      <p className="text-[13px] text-text-muted">{t('editor.edit_hint')}</p>

      {state.error ? <ErrorBanner error={state.error} /> : null}
      {state.progress ? <p className="text-[13px] text-text-muted">{state.progress}</p> : null}

      {state.edits.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {state.edits.map((e) => (
            <li
              key={e.id}
              className={`rounded-lg border p-2 ${
                state.selectedId === e.id ? 'border-accent' : 'border-border-strong'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12.5px] font-semibold text-text-muted">
                  {t('editor.edit_original')}: {e.text}
                </span>
                <button
                  type="button"
                  onClick={() => state.onRemoveEdit(e.id)}
                  className="min-h-7 rounded-md border border-border-strong px-2 text-[12px] font-semibold"
                >
                  ×
                </button>
              </div>
              <label className="mt-1.5 block text-[12.5px] font-semibold">
                {t('editor.edit_replace')}
                <input
                  type="text"
                  value={e.replacement}
                  onChange={(ev) => state.onReplacementChange(e.id, ev.target.value)}
                  placeholder={t('editor.edit_whiteout_placeholder')}
                  data-testid="edit-replacement-input"
                  className="mt-1 w-full rounded-lg border border-border-strong bg-surface-card px-2.5 py-1.5 text-[13.5px] outline-none focus:border-accent"
                />
              </label>
              <p className="mt-1 text-[11.5px] text-text-muted">{t('editor.edit_whiteout_hint')}</p>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="button" disabled={applyDisabled} onClick={state.runApply} className="flex-1">
          {t('editor.apply')}
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={!state.canUndo || state.busy} onClick={state.onUndo}>
          {t('editor.undo')}
        </Button>
      </div>
      <p className="text-[13px] text-text-muted">{t('editor.edits_count', { n: state.edits.length })}</p>

      {state.lastOutput ? (
        <ContinueChip bytes={state.lastOutput.bytes} filename={state.lastOutput.filename} />
      ) : null}
    </div>
  );
}
