import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { engine } from '../../engine/client';
import { deliverBytes } from '../../lib/download';
import { AnnotateCanvas, newMarkId, type AnnotateItem } from './editor-canvas';
import { ContinueChip } from './continue-chip';
import { useLastOutput } from '../../hooks/use-last-output';
import { Button } from '../ui/button';
import { ErrorBanner, type ErrorDetail } from '../ui/error-banner';
import { isEngineCrashedError } from '../../lib/engine-error';
import type { AnnotateElementKind } from '../../engine/pdf-lib';

/*
 * Annotate tab (v0.9.0 phase 4): stamps & shapes as an EDIT LIST — elements
 * live in React state and Apply makes ONE stampAnnotations call (form
 * re-apply semantics, the watermark model; no intermediate PDF states).
 * Elements are fractions of the visible page box; the visual-pt conversion
 * happens at apply time via pdf.js page sizes (lazily, pages with elements
 * only). The tab owns its state in `useAnnotateState` and renders through
 * TWO slots of the editor shell: `AnnotateCanvasArea` in the main column
 * (under the shared page nav) and `AnnotateControls` in the side panel.
 */

type Kind = AnnotateElementKind;

const COLORS = ['#111111', '#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#ffffff'];

const kindLabelKey = (k: Kind): string =>
  k === 'text'
    ? 'editor.tool_text'
    : k === 'rect'
      ? 'editor.shape_rect'
      : k === 'line'
        ? 'editor.shape_line'
        : 'editor.shape_ellipse';

interface DrawShape {
  nx: number;
  nyTop: number;
  nw: number;
  nh: number;
}

export interface AnnotateState {
  pageItems: AnnotateItem[];
  total: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDraw: (draft: DrawShape) => void;
  onItemMove: (id: string, pos: DrawShape) => void;
  kind: Kind;
  setKind: (k: Kind) => void;
  color: string;
  setColor: (c: string) => void;
  opacity: number;
  setOpacity: (o: number) => void;
  size: number;
  setSize: (s: number) => void;
  fill: boolean;
  setFill: (f: boolean) => void;
  textValue: string;
  setTextValue: (v: string) => void;
  deleteSelected: () => void;
  undo: () => void;
  canUndo: boolean;
  busy: boolean;
  runApply: () => void;
  runError: string | ErrorDetail | null;
  progress: string | null;
  lastOutput: { bytes: Uint8Array; filename: string } | null;
}

export function useAnnotateState(
  bytes: Uint8Array,
  fileName: string,
  page: number,
): AnnotateState {
  const { t } = useTranslation(['common', 'tools']);
  const { lastOutput, keep } = useLastOutput();
  const [items, setItems] = useState<AnnotateItem[]>([]);
  const [history, setHistory] = useState<AnnotateItem[][]>([]);
  const [kind, setKind] = useState<Kind>('text');
  const [color, setColor] = useState(COLORS[1]!);
  const [opacity, setOpacity] = useState(100);
  const [size, setSize] = useState(14);
  const [fill, setFill] = useState(true);
  const [textValue, setTextValue] = useState('PDF Toolkit');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | ErrorDetail | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const sizeCache = useRef(new Map<number, { width: number; height: number }>());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const busy = progress !== null;

  const pushHistory = useCallback((prev: AnnotateItem[]) => {
    setHistory((h) => [...h.slice(-49), prev]);
  }, []);

  const onDraw = useCallback(
    (draft: DrawShape) => {
      pushHistory(itemsRef.current);
      const item: AnnotateItem = {
        id: newMarkId(),
        page,
        ...draft,
        kind,
        color,
        opacity: opacity / 100,
        size,
        fill: kind === 'rect' || kind === 'ellipse' ? fill : false,
        text: kind === 'text' ? textValue || ' ' : undefined,
      };
      setItems((prev) => [...prev, item]);
      setSelectedId(item.id);
    },
    [page, kind, color, opacity, size, fill, textValue, pushHistory],
  );

  const onItemMove = useCallback(
    (id: string, pos: DrawShape) => {
      pushHistory(itemsRef.current);
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...pos } : i)));
    },
    [pushHistory],
  );

  const patchSelected = useCallback(
    (patch: Partial<AnnotateItem>) => {
      if (!selectedId) return;
      setItems((prev) => prev.map((i) => (i.id === selectedId ? { ...i, ...patch } : i)));
    },
    [selectedId],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    pushHistory(itemsRef.current);
    setItems((prev) => prev.filter((i) => i.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, pushHistory]);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      setItems(h[h.length - 1]!);
      setSelectedId(null);
      return h.slice(0, -1);
    });
  }, []);

  const pickColor = useCallback(
    (c: string) => {
      setColor(c);
      patchSelected({ color: c });
    },
    [patchSelected],
  );

  const runApply = useCallback(() => {
    void (async () => {
      setRunError(null);
      if (itemsRef.current.length === 0) {
        setRunError(t('editor.err_no_elements'));
        return;
      }
      try {
        setProgress(t('editor.progress_working'));
        // Lazily resolve visual sizes for pages carrying elements only.
        const pages = new Set(itemsRef.current.map((i) => i.page));
        for (const p of pages) {
          if (!sizeCache.current.has(p)) {
            const { getPageVisualSize } = await import('../../engine/pdfjs');
            sizeCache.current.set(p, await getPageVisualSize(bytes, p));
          }
        }
        const elements = itemsRef.current.map((i) => {
          const { width, height } = sizeCache.current.get(i.page)!;
          return {
            kind: i.kind,
            page: i.page,
            x: i.nx * width,
            y: (1 - i.nyTop - i.nh) * height,
            w: i.nw * width,
            h: i.nh * height,
            color: i.color,
            opacity: i.opacity,
            size: i.size,
            fill: i.fill,
            text: i.text,
          };
        });
        const out = await engine.stampAnnotations(bytes, { elements });
        const name = annotatedName(fileName);
        if (await deliverBytes(out, name, 'download')) {
          keep(out, name);
          setProgress(t('editor.progress_done'));
        } else {
          setProgress(null); // picker cancelled — not an error
        }
      } catch (e) {
        setProgress(null);
        const errName = e instanceof Error ? e.name : '';
        if (errName === 'AnnotationRefusedError') {
          setRunError(
            /fit/i.test(e instanceof Error ? e.message : '')
              ? t('editor.err_overflow')
              : t('editor.err_annot_refused'),
          );
          return;
        }
        if (isEngineCrashedError(e)) {
          setRunError({
            title: t('editor.err_crashed'),
            detail: t('editor.err_crashed_detail'),
            onRetry: () => runApply(),
          });
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        setRunError(t('editor.err_failed', { message }));
      }
    })();
  }, [bytes, fileName, t, keep]);

  return {
    pageItems: items.filter((i) => i.page === page),
    total: items.length,
    selectedId,
    onSelect: setSelectedId,
    onDraw,
    onItemMove,
    kind,
    setKind,
    color,
    setColor: pickColor,
    opacity,
    setOpacity,
    size,
    setSize,
    fill,
    setFill,
    textValue,
    setTextValue,
    deleteSelected,
    undo,
    canUndo: history.length > 0,
    busy,
    runApply,
    runError,
    progress,
    lastOutput,
  };
}

/** The canvas slot of the annotate tab (main column, under the page nav). */
export function AnnotateCanvasArea({
  state,
  bytes,
  page,
  version,
  visualWidth,
  disabled,
}: {
  state: AnnotateState;
  bytes: Uint8Array;
  page: number;
  version: number | string;
  /** VISUAL width in pt — scales text previews to the render. */
  visualWidth: number;
  disabled: boolean;
}) {
  return (
    <AnnotateCanvas
      bytes={bytes}
      page={page}
      version={version}
      items={state.pageItems}
      selectedId={state.selectedId}
      visualWidth={visualWidth}
      onDraw={state.onDraw}
      onItemMove={state.onItemMove}
      onSelect={state.onSelect}
      disabled={disabled}
    />
  );
}

/** The controls slot of the annotate tab (side panel). */
export function AnnotateControls({ state }: { state: AnnotateState }) {
  const { t } = useTranslation(['common', 'tools']);
  return (
    <div className="flex flex-col gap-3">
      <div
        className="grid grid-cols-4 gap-1 rounded-lg border border-border-strong p-1"
        role="group"
        aria-label={t('editor.tab_annotate')}
      >
        {(['text', 'rect', 'line', 'ellipse'] as Kind[]).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={state.kind === k}
            onClick={() => state.setKind(k)}
            className={`min-h-9 rounded-md text-[12.5px] font-semibold transition ${
              state.kind === k ? 'bg-accent text-text-on-accent' : 'text-text-muted hover:bg-surface-hover'
            }`}
          >
            {t(kindLabelKey(k))}
          </button>
        ))}
      </div>
      <p className="text-[13px] leading-relaxed text-text-muted">{t('editor.annotate_hint')}</p>

      <div className="flex items-center gap-1.5">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={t('editor.color_label')}
            aria-pressed={state.color === c}
            onClick={() => state.setColor(c)}
            className={`h-7 w-7 shrink-0 rounded-md border ${state.color === c ? 'ring-2 ring-accent' : 'border-border-strong'}`}
            style={{ backgroundColor: c }}
          />
        ))}
        <input
          type="color"
          value={state.color}
          onChange={(e) => state.setColor(e.target.value)}
          aria-label={t('editor.color_label')}
          className="h-7 w-9 cursor-pointer rounded-md border border-border-strong bg-transparent"
        />
      </div>

      {state.kind === 'text' ? (
        <label className="block text-[13px] font-semibold">
          {t('editor.stamp_text_label')}
          <input
            type="text"
            value={state.textValue}
            onChange={(e) => state.setTextValue(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border-strong bg-surface-card px-3 py-2 text-sm"
            placeholder={t('editor.text_placeholder')}
          />
        </label>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[13px] font-semibold">
          {t('editor.size_label')}
          <input
            type="number"
            min={4}
            max={144}
            value={state.size}
            onChange={(e) => state.setSize(Math.max(4, Math.min(144, Number(e.target.value) || 14)))}
            className="mt-1 w-full rounded-lg border border-border-strong bg-surface-card px-2 py-1.5 text-[13px] tabular-nums"
          />
        </label>
        <label className="block text-[13px] font-semibold">
          {t('editor.opacity_label', { value: state.opacity })}
          <input
            type="range"
            min={5}
            max={100}
            value={state.opacity}
            onChange={(e) => state.setOpacity(Number(e.target.value))}
            className="mt-1 w-full accent-accent"
          />
        </label>
      </div>

      {state.kind === 'rect' || state.kind === 'ellipse' ? (
        <label className="flex items-center gap-2 text-[13px] font-semibold">
          <input
            type="checkbox"
            checked={state.fill}
            onChange={(e) => state.setFill(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          {t('editor.fill_label')}
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={state.runApply} disabled={state.busy || state.total === 0}>
          {t('editor.apply')}
        </Button>
        <button
          type="button"
          onClick={state.undo}
          disabled={!state.canUndo || state.busy}
          className="min-h-9 rounded-lg border border-border-strong px-3 text-[13px] font-semibold disabled:opacity-40"
        >
          {t('editor.undo')}
        </button>
        <span className="text-[13px] text-text-muted tabular-nums">
          {t('editor.elements_count', { n: state.total })}
        </span>
      </div>

      {state.pageItems.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[12.5px] text-text-muted">
          {state.pageItems.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => state.onSelect(i.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-surface-hover ${
                  i.id === state.selectedId ? 'bg-surface-hover font-semibold' : ''
                }`}
              >
                <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: i.color }} />
                <span>{t(kindLabelKey(i.kind))}</span>
                {i.kind === 'text' ? <span className="truncate">· {i.text}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {state.lastOutput ? (
        <ContinueChip bytes={state.lastOutput.bytes} filename={state.lastOutput.filename} />
      ) : null}
      {state.progress ? null : <span className="text-[13px] text-text-muted">{t('editor.progress_idle')}</span>}
      {state.runError ? <ErrorBanner error={state.runError} /> : null}
      {state.progress ? <p className="text-[13px] text-text-muted">{state.progress}</p> : null}
    </div>
  );
}

function annotatedName(original: string): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'document';
  return `${base}-annotated.pdf`;
}
