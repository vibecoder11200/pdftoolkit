import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { engine } from '../../engine/client';
import type { CropPageBox } from '../../engine/pdf-lib';
import { deliverBytes } from '../../lib/download';
import { suggestCropBox, type FracBox } from '../../lib/content-bbox';
import { REDACT_RASTER_BUDGET, type RedactMark } from '../../lib/redact-pipeline';
import { CanvasFrame, usePageCanvas } from './editor-canvas';
import { ContinueChip } from './continue-chip';
import { useLastOutput } from '../../hooks/use-last-output';
import { Button } from '../ui/button';
import { ErrorBanner, type ErrorDetail } from '../ui/error-banner';
import { isEngineCrashedError } from '../../lib/engine-error';

/*
 * Crop tab (v0.9.0 phase 7): manual drag box + auto-suggest → setCropBox
 * (MediaBox untouched). CROP IS NOT REDACTION — the copy says so; the
 * destruction route ("cắt như che đi") sends the INVERSE region through
 * src/lib/redact-pipeline.ts (the wrapper, never bare primitives).
 */

const MIN_BOX = 0.02; // ignore accidental sub-2% drags

export interface CropState {
  draft: FracBox | null;
  suggested: FracBox | null;
  scope: 'all' | 'page';
  destroy: boolean;
  busy: boolean;
  progress: string | null;
  error: string | ErrorDetail | null;
  lastOutput: { bytes: Uint8Array; filename: string } | null;
  setDraft: (b: FracBox | null) => void;
  setScope: (s: 'all' | 'page') => void;
  setDestroy: (d: boolean) => void;
  autoSuggest: () => void;
  runApply: (confirmed?: boolean) => void;
  rasterConfirm: boolean;
  pixelsRef: RefObject<(() => { width: number; height: number; data: Uint8ClampedArray } | null) | null>;
}

export function useCropState(
  bytes: Uint8Array,
  fileName: string,
  page: number,
  numPages: number,
): CropState {
  const { t } = useTranslation('common');
  const [draft, setDraft] = useState<FracBox | null>(null);
  const [suggested, setSuggested] = useState<FracBox | null>(null);
  const [scope, setScope] = useState<'all' | 'page'>('all');
  const [destroy, setDestroy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [rasterConfirm, setRasterConfirm] = useState(false);
  const [error, setError] = useState<string | ErrorDetail | null>(null);
  const { lastOutput, keep } = useLastOutput();
  const pixelsRef = useRef<(() => { width: number; height: number; data: Uint8ClampedArray } | null) | null>(null);
  const stateRef = useRef({ draft, scope, destroy, page, numPages, bytes, fileName, busy });
  stateRef.current = { draft, scope, destroy, page, numPages, bytes, fileName, busy };

  const autoSuggest = useCallback(() => {
    setError(null);
    void (async () => {
      try {
        const pixels = pixelsRef.current?.() ?? null;
        const box = await suggestCropBox(stateRef.current.bytes, stateRef.current.page, pixels);
        setSuggested(box);
        if (box) setDraft(box);
      } catch {
        setError(t('editor.crop_suggest_failed'));
      }
    })();
  }, [t]);

  const runApply = useCallback((confirmed?: boolean) => {
    const s = stateRef.current;
    if (s.busy || !s.draft) return;
    setError(null);
    setBusy(true);
    setProgress(t('editor.progress_working'));
    void (async () => {
      try {
        const base = s.fileName.replace(/\.pdf$/i, '');
        if (s.destroy) {
          // Crop-as-redaction: the INVERSE region rides the verified redact
          // wrapper (raster tier) — never a bare CropBox.
          const pages = s.scope === 'all' ? Array.from({ length: s.numPages }, (_, i) => i + 1) : [s.page];
          // Raster budget (finding 11 parity with the redact tab): forceRaster
          // rasterizes EVERY in-scope page — above the cap the first click
          // only arms the confirm.
          if (pages.length > REDACT_RASTER_BUDGET && !confirmed) {
            setRasterConfirm(true);
            setProgress(null);
            return;
          }
          setRasterConfirm(false);
          const { runRedactionPipeline: run } = await import('../../lib/redact-pipeline');
          const census = await engine.redactCensus(s.bytes);
          const d = s.draft!;
          const bands: { nx: number; nyTop: number; nw: number; nh: number }[] = [
            { nx: 0, nyTop: 0, nw: 1, nh: d.nyTop },
            { nx: 0, nyTop: d.nyTop + d.nh, nw: 1, nh: Math.max(0, 1 - d.nyTop - d.nh) },
            { nx: 0, nyTop: d.nyTop, nw: d.nx, nh: d.nh },
            { nx: d.nx + d.nw, nyTop: d.nyTop, nw: Math.max(0, 1 - d.nx - d.nw), nh: d.nh },
          ];
          const marks: RedactMark[] = [];
          for (const p of pages) {
            bands.forEach((b, i) => {
              if (b.nw > 0.0005 && b.nh > 0.0005) marks.push({ id: `crop-rm-${p}-${i}`, page: p, ...b });
            });
          }
          const outcome = await run(
            s.bytes,
            census,
            {
              marks,
              burnPages: [],
              keptFlagged: [],
              forceRaster: true,
              scrubSkip: [],
              // Sentinel keyword: the destruction guarantee here is the
              // raster replacement, not a keyword scan.
              secrets: ['PDFTOOLKIT-CROP'],
            },
          );
          if (await deliverBytes(outcome.result.bytes, `${base}-cropped-secure.pdf`, 'download')) {
            keep(outcome.result.bytes, `${base}-cropped-secure.pdf`);
            setProgress(t('editor.progress_done'));
          } else {
            setProgress(null);
          }
        } else {
          // FracBox (top-left origin) → CropFracRect (bottom-left origin).
          const cropRect = {
            x: s.draft!.nx,
            y: 1 - s.draft!.nyTop - s.draft!.nh,
            w: s.draft!.nw,
            h: s.draft!.nh,
          };
          const boxes: CropPageBox[] =
            s.scope === 'all'
              ? Array.from({ length: s.numPages }, (_, i) => ({ page: i + 1, rect: cropRect }))
              : [{ page: s.page, rect: cropRect }];
          const out = await engine.cropPages(s.bytes, boxes);
          if (await deliverBytes(out, `${base}-cropped.pdf`, 'download')) {
            keep(out, `${base}-cropped.pdf`);
            setProgress(t('editor.progress_done'));
          } else {
            setProgress(null);
          }
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
        if (name === 'CropRefusedError' && /signed/i.test(e instanceof Error ? e.message : '')) {
          setError(t('editor.err_signed'));
          return;
        }
        if (name === 'CropRefusedError' || name === 'RedactRefusedError' || name === 'RedactVerifyError') {
          setError(t('editor.crop_refused', { message: e instanceof Error ? e.message : String(e) }));
          return;
        }
        setError(t('editor.err_failed', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    })();
  }, [keep, t]);

  // New page or file → drop the box/suggestion (they are page-specific).
  useEffect(() => {
    setDraft(null);
    setSuggested(null);
    setRasterConfirm(false);
  }, [bytes, page]);

  return {
    draft,
    suggested,
    scope,
    destroy,
    busy,
    progress,
    error,
    lastOutput,
    setDraft,
    setScope,
    setDestroy,
    autoSuggest,
    runApply,
    rasterConfirm,
    pixelsRef,
  };
}

/** Page canvas + drag box overlay (suggested box shown while no draft). */
export function CropArea({
  bytes,
  page,
  version,
  state,
}: {
  bytes: Uint8Array;
  page: number;
  version: number | string;
  state: CropState;
}) {
  const { wrapRef, canvasRef, overlayRef, width, norm } = usePageCanvas(bytes, page, version);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [pending, setPending] = useState<FracBox | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    startRef.current = norm(e.clientX, e.clientY);
    setPending(null);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const p = norm(e.clientX, e.clientY);
    const s = startRef.current;
    setPending({
      nx: Math.min(s.x, p.x),
      nyTop: Math.min(s.y, p.y),
      nw: Math.abs(p.x - s.x),
      nh: Math.abs(p.y - s.y),
    });
  };
  const onPointerUp = () => {
    const p = pending;
    startRef.current = null;
    setPending(null);
    if (p && p.nw >= MIN_BOX && p.nh >= MIN_BOX) state.setDraft(p);
  };

  // Expose the rendered pixels to the controls' auto-suggest.
  useEffect(() => {
    state.pixelsRef.current = () => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width === 0) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { width: img.width, height: img.height, data: img.data };
    };
    return () => {
      state.pixelsRef.current = null;
    };
  }, [canvasRef, state.pixelsRef]);

  const shown = pending ?? state.draft ?? state.suggested;
  const isSuggestionOnly = !pending && !state.draft && !!state.suggested;
  return (
    <CanvasFrame
      wrapRef={wrapRef}
      canvasRef={canvasRef}
      width={width}
      overlayRef={overlayRef}
      disabled={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      testid="crop-overlay"
    >
      {shown ? (
        <div
          data-testid={isSuggestionOnly ? 'crop-suggestion' : 'crop-box'}
          className={`pointer-events-none absolute border-2 ${
            isSuggestionOnly ? 'border-dashed border-amber-500/80 bg-amber-400/10' : 'border-accent bg-accent/15'
          }`}
          style={{
            left: `${shown.nx * 100}%`,
            top: `${shown.nyTop * 100}%`,
            width: `${shown.nw * 100}%`,
            height: `${shown.nh * 100}%`,
          }}
        />
      ) : null}
    </CanvasFrame>
  );
}

export function CropControls({ state }: { state: CropState }) {
  const { t } = useTranslation('common');
  const applyDisabled = state.busy || !state.draft;
  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[12.5px] leading-relaxed text-text-primary">
        {t('editor.crop_not_redaction')}
      </p>
      <p className="text-[13px] text-text-muted">{t('editor.crop_hint')}</p>

      {state.error ? <ErrorBanner error={state.error} /> : null}
      {state.progress ? <p className="text-[13px] text-text-muted">{state.progress}</p> : null}

      <Button type="button" variant="secondary" size="sm" onClick={state.autoSuggest} disabled={state.busy}>
        {t('editor.crop_auto')}
      </Button>

      <div role="group" aria-label={t('editor.crop_scope')} className="flex gap-1 rounded-lg border border-border-strong p-1">
        {(['all', 'page'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={state.scope === s}
            onClick={() => state.setScope(s)}
            className={`min-h-9 flex-1 rounded-md px-2 text-[13px] font-semibold ${
              state.scope === s ? 'bg-accent text-text-on-accent' : 'text-text-muted hover:bg-surface-hover'
            }`}
          >
            {t(s === 'all' ? 'editor.crop_all' : 'editor.crop_selected')}
          </button>
        ))}
      </div>

      <label className="flex items-start gap-2 text-[12.5px] leading-relaxed text-text-muted">
        <input
          type="checkbox"
          checked={state.destroy}
          onChange={(e) => state.setDestroy(e.target.checked)}
          className="mt-0.5"
          data-testid="crop-destroy"
        />
        <span>{t('editor.crop_destroy_label')}</span>
      </label>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          disabled={applyDisabled}
          onClick={() => state.runApply(state.rasterConfirm)}
          className="flex-1"
        >
          {state.rasterConfirm
            ? t('redact.confirm_budget', { count: REDACT_RASTER_BUDGET })
            : t('editor.crop_apply')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!state.draft || state.busy}
          onClick={() => state.setDraft(null)}
        >
          {t('editor.crop_reset')}
        </Button>
      </div>
      {state.rasterConfirm ? (
        <p className="text-[13px] leading-relaxed text-text-muted">{t('redact.budget_note')}</p>
      ) : null}

      {state.lastOutput ? (
        <ContinueChip bytes={state.lastOutput.bytes} filename={state.lastOutput.filename} />
      ) : null}
    </div>
  );
}
