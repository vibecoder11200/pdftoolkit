import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PDFDocument } from 'pdf-lib';

import { engine, getWorker } from '../../engine/client';
import { getPageVisualSize, renderPageToCanvas } from '../../engine/pdfjs';
import {
  assertExportAllocation,
  CLEANUP_DEFAULTS,
  deskewSearch,
  type CleanupSettings,
} from '../../lib/scan-cleanup';
import { detectOrientation } from '../../lib/scan-orientation';
import { useDelivery } from '../../lib/use-delivery';
import { engineErrorDetail } from '../../lib/engine-error';
import { beginJob, endJob } from '../../lib/jobs';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { checkPdfFile } from '../../lib/file-accept';
import { DeliveryReportBar } from './delivery-report-bar';

/*
 * Phase-6 scan cleanup (tool #23): deskew + enhance dirty scans, with the
 * RT5 orientation SUGGESTION (local DetectOS, confirm-only — never
 * auto-apply; the 90/270 mirror class is disclosed in the UI).
 *
 * Pipeline: render -> worker cleanupRaster (deskew at full res + enhance)
 * -> worker encodeJpeg -> main-thread pdf-lib compose (the img-to-pdf
 * pattern). Outputs ride the phase-3 delivery contract. Signed inputs
 * refuse via the shared predicate op. OCR-after chains through the
 * existing OCR tool via the ContinueChip handoff (the composer runs
 * inside the OCR tool — no composer duplication here).
 */

interface SrcFile {
  bytes: Uint8Array;
  name: string;
  numPages: number;
  sizes: { width: number; height: number }[];
}

const PREVIEW_LONG_EDGE = 420;

export function ScanCleanupTool() {
  const { t } = useTranslation('common');
  const [src, setSrc] = useState<SrcFile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [settings, setSettings] = useState<CleanupSettings>(CLEANUP_DEFAULTS);
  const [deskew, setDeskew] = useState<{ angle: number; on: boolean }>({ angle: 0, on: false });
  const [manualRotation, setManualRotation] = useState(0);
  const [suggestion, setSuggestion] = useState<{ degrees: number; confidence: number | null } | null>(null);
  const [suggestionBusy, setSuggestionBusy] = useState(false);
  const [exportDpi, setExportDpi] = useState(150);
  const [busy, setBusy] = useState(false);
  const [progress, setProgressState] = useState({ current: 0, total: 0 });
  const [previewTick] = useState(0);
  const delivery = useDelivery();
  const srcRef = useRef<SrcFile | null>(null);
  srcRef.current = src;


  const reset = useCallback(() => {
    setSrc(null);
    setLoadError(null);
    setRunError(null);
    setPage(1);
    setSettings(CLEANUP_DEFAULTS);
    setDeskew({ angle: 0, on: false });
    setManualRotation(0);
    setSuggestion(null);
    delivery.clear();
  }, [delivery]);

  const addFiles = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      reset();
      const gate = await checkPdfFile(file);
      if (!gate.ok) {
        setLoadError(t('cleanup.err_file', { name: file.name }));
        return;
      }
      try {
        beginJob('cleanup-intake');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const owned = bytes.slice(0);
        const { info } = await engine.loadPdf(owned);
        const n = info.numPages;
        if (n > 100) {
          setLoadError(t('cleanup.page_cap'));
          return;
        }
        const signed = await engine.hasDigitalSignature(owned);
        if (signed) {
          setLoadError(t('cleanup.signed'));
          return;
        }
        const sizes: { width: number; height: number }[] = [];
        for (let p = 1; p <= n; p += 1) {
          sizes.push(await getPageVisualSize(owned, p));
        }
        setSrc({ bytes: owned, name: file.name, numPages: n, sizes });
      } catch (e) {
        const d = engineErrorDetail(e, t('cleanup.err_load'), { title: t('cleanup.err_crash_title'), detail: t('cleanup.err_crash') }, () => setLoadError(null));
        setLoadError(typeof d === 'string' ? d : (d.detail ?? t('cleanup.err_load')));
      } finally {
        endJob('cleanup-intake');
      }
    },
    [reset, t],
  );

  /** Preview render: low-res before/after side by side (bounded scale). */
  const renderPreview = useCallback(async () => {
    const file = srcRef.current;
    if (!file) return;
    const size = file.sizes[page - 1];
    if (!size) return;
    const scale = PREVIEW_LONG_EDGE / Math.max(size.width, size.height);
    const canvas = document.createElement('canvas');
    await renderPageToCanvas(file.bytes, page, canvas, scale);
    const beforeCtx = document
      .getElementById('cleanup-before')
      ?.querySelector('canvas') as HTMLCanvasElement | null;
    const afterHost = document.getElementById('cleanup-after');
    const afterCanvas = document.createElement('canvas');
    // deskew search on the PREVIEW raster (bounded); applied at full res on export
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const best = deskewSearch(img);
    // apply manual rotation + deskew + cleanup on the PREVIEW pixels
    // total rotation = deskew correction + manual rotation (same worker path)
    const pixels = await engine.cleanupRaster(img, (deskew.on ? best.angle : 0) + manualRotation, settings);
    const rotPixels = pixels;
    // paint before
    if (beforeCtx) {
      beforeCtx.width = canvas.width;
      beforeCtx.height = canvas.height;
      beforeCtx.getContext('2d')?.putImageData(img, 0, 0);
    }
    // paint after
    if (afterHost) {
      afterCanvas.width = rotPixels.width;
      afterCanvas.height = rotPixels.height;
      const actx = afterCanvas.getContext('2d');
      if (actx) {
        const outImg = actx.createImageData(rotPixels.width, rotPixels.height);
        outImg.data.set(rotPixels.data);
        actx.putImageData(outImg, 0, 0);
      }
      afterHost.replaceChildren(afterCanvas);
    }
  }, [deskew, manualRotation, page, settings]);

  useEffect(() => {
    const h = setTimeout(() => void renderPreview(), 120);
    return () => clearTimeout(h);
  }, [renderPreview, previewTick]);

  const askOrientation = useCallback(async () => {
    const file = srcRef.current;
    if (!file) return;
    setSuggestionBusy(true);
    try {
      const size = file.sizes[page - 1];
      const scale = PREVIEW_LONG_EDGE / Math.max(size!.width, size!.height);
      const canvas = document.createElement('canvas');
      await renderPageToCanvas(file.bytes, page, canvas, scale);
      const v = await detectOrientation(canvas);
      setSuggestion({ degrees: v.suggestDegrees, confidence: v.confidence });
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggestionBusy(false);
    }
  }, [page]);

  const exportPdf = useCallback(async () => {
    const file = srcRef.current;
    if (!file) return;
    setBusy(true);
    setRunError(null);
    try {
      beginJob('cleanup-export');
      const parts: { jpeg: Uint8Array; width: number; height: number }[] = [];
      for (let p = 1; p <= file.numPages; p += 1) {
        const size = file.sizes[p - 1]!;
        // allocation gate (typed refusals) + render scale from DPI
        const alloc = assertExportAllocation(file.numPages, size.width, size.height, exportDpi);
        const scale = alloc.width / size.width;
        const canvas = document.createElement('canvas');
        await renderPageToCanvas(file.bytes, p, canvas, scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d context unavailable');
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // per-page settings: v1 applies the SAME settings to all pages
        // (apply-to-all); per-page overrides land with the batch phase.
        const best = deskewSearch(img);
        const pixels = await engine.cleanupRaster(img, (deskew.on ? best.angle : 0) + manualRotation, settings);
        const jpeg = await getWorker().encodeJpeg(
          { data: pixels.data, width: pixels.width, height: pixels.height },
          { quality: 85 },
        );
        parts.push({ jpeg, width: pixels.width, height: pixels.height });
        setProgress(p, file.numPages);
      }
      // compose on main thread (the img-to-pdf pattern)
      const out = await PDFDocument.create();
      for (const part of parts) {
        const embedded = await out.embedJpg(part.jpeg);
        const pPage = out.addPage([part.width, part.height]);
        pPage.drawImage(embedded, { x: 0, y: 0, width: part.width, height: part.height });
      }
      const bytes = await out.save({ useObjectStreams: false });
      const stem = file.name.replace(/\.pdf$/i, '');
      await delivery.deliver([{ filename: `${stem}-da-ve-sinh.pdf`.replace('-da-ve-sinh', t('cleanup.suffix')), bytes }]);
      setProgress(0, 0);
    } catch (e) {
      const d = engineErrorDetail(e, t('cleanup.err_run'), { title: t('cleanup.err_crash_title'), detail: t('cleanup.err_crash') }, () => void exportPdf());
      setRunError(typeof d === 'string' ? d : (d.detail ?? t('cleanup.err_run')));
    } finally {
      setBusy(false);
      endJob('cleanup-export');
    }
  }, [delivery, deskew, exportDpi, manualRotation, settings, t]);

  const setProgress = (current: number, total: number) => setProgressState({ current, total });

  if (!src) {
    return (
      <WorkspaceShell
        title={t('cleanup.title')}
        error={loadError}
        steps={[{ key: 'pick', label: t('steps.pick'), state: 'now' }]}
        side={<p className="text-[13px] text-text-muted">{t('cleanup.intro')}</p>}
      >
        <Dropzone
          onFiles={(files) => void addFiles(files)}
          accept=".pdf"
          title={t('cleanup.drop')}
          hint={t('cleanup.intro')}
        />
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell
      title={t('cleanup.title')}
      error={loadError ?? runError}
      steps={[
        { key: 'load', label: t('cleanup.step_load'), state: 'done' },
        { key: 'edit', label: t('cleanup.step_edit'), state: 'now' },
        { key: 'download', label: t('steps.download'), state: 'todo' },
      ]}
      side={
        <div className="flex flex-col gap-2 text-[13px]">
          <p className="font-semibold">{t('cleanup.settings')}</p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={deskew.on}
              onChange={(e) => setDeskew((d) => ({ ...d, on: e.target.checked }))}
              data-testid="cleanup-deskew"
            />
            {t('cleanup.deskew')}
          </label>
          <label className="flex flex-col gap-1">
            {t('cleanup.mode')}
            <select
              className="min-h-8 rounded border border-border-strong bg-surface-card px-1"
              data-testid="cleanup-mode"
              value={settings.mode}
              onChange={(e) => setSettings({ ...settings, mode: e.target.value as CleanupSettings['mode'] })}
            >
              <option value="none">{t('cleanup.mode_none')}</option>
              <option value="grayscale">{t('cleanup.mode_gray')}</option>
              <option value="flatten">{t('cleanup.mode_flatten')}</option>
              <option value="threshold">{t('cleanup.mode_threshold')}</option>
              <option value="adaptive">{t('cleanup.mode_adaptive')}</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            {t('cleanup.brightness')} {settings.brightness}
            <input
              type="range" min={-100} max={100}
              value={settings.brightness}
              data-testid="cleanup-brightness"
              onChange={(e) => setSettings({ ...settings, brightness: Number(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            {t('cleanup.contrast')} {settings.contrast}
            <input
              type="range" min={-100} max={100}
              value={settings.contrast}
              data-testid="cleanup-contrast"
              onChange={(e) => setSettings({ ...settings, contrast: Number(e.target.value) })}
            />
          </label>
          <div className="flex flex-col gap-1">
            {t('cleanup.rotation')}
            <div className="flex gap-1">
              {[0, 90, 180, 270].map((deg) => (
                <button
                  key={deg}
                  type="button"
                  className={`min-h-8 rounded border px-2 ${
                    manualRotation === deg ? 'border-accent bg-accent-soft font-semibold' : 'border-border-strong'
                  }`}
                  data-testid={`cleanup-rot-${deg}`}
                  onClick={() => setManualRotation(deg)}
                >
                  {deg}°
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1 rounded border border-border-strong p-2">
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                data-testid="cleanup-orient-ask"
                disabled={suggestionBusy}
                onClick={() => void askOrientation()}
              >
                {t('cleanup.orient_ask')}
              </Button>
              {suggestion && (
                <span className="text-[12px]" data-testid="cleanup-orient-verdict">
                  {t('cleanup.orient_verdict', { deg: suggestion.degrees, conf: suggestion.confidence == null ? '—' : Math.round(suggestion.confidence * 100) })}
                </span>
              )}
            </div>
            {suggestion && (
              <p className="text-[11px] text-tone-orange">
                {t('cleanup.orient_warning')}
              </p>
            )}
            {suggestion && (
              <Button variant="secondary" data-testid="cleanup-orient-apply" onClick={() => setManualRotation(suggestion.degrees)}>
                {t('cleanup.orient_apply')}
              </Button>
            )}
          </div>

          <label className="flex items-center gap-2">
            {t('cleanup.dpi')}
            <select
              className="min-h-8 rounded border border-border-strong bg-surface-card px-1"
              data-testid="cleanup-dpi"
              value={exportDpi}
              onChange={(e) => setExportDpi(Number(e.target.value))}
            >
              <option value="110">110</option>
              <option value="150">150</option>
              <option value="200">200</option>
              <option value="300">300</option>
            </select>
          </label>
          {busy && progress.total > 0 && (
            <p className="text-[12px] text-text-muted" data-testid="cleanup-progress">
              {t('cleanup.progress', { current: progress.current, total: progress.total })}
            </p>
          )}
          <Button data-testid="cleanup-export" onClick={() => void exportPdf()} disabled={busy}>
            {busy ? t('cleanup.exporting') : t('cleanup.export_cta')}
          </Button>
          {delivery.report && (
            <DeliveryReportBar report={delivery.report} onRetry={delivery.retry} onDismiss={delivery.dismiss} busy={busy} />
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-[12px]">
          <Button variant="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            ←
          </Button>
          <span data-testid="cleanup-page-indicator">
            {t('cleanup.page_n', { current: page, total: src.numPages })}
          </span>
          <Button variant="secondary" onClick={() => setPage((p) => Math.min(src.numPages, p + 1))} disabled={page >= src.numPages}>
            →
          </Button>
          <Button variant="secondary" data-testid="cleanup-reset" onClick={() => { setSettings(CLEANUP_DEFAULTS); setDeskew({ angle: 0, on: false }); setManualRotation(0); setSuggestion(null); }}>
            {t('cleanup.reset')}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-border-strong p-1" id="cleanup-before">
            <p className="text-[11px] text-text-muted">{t('cleanup.before')}</p>
            <canvas data-testid="cleanup-before-canvas" />
          </div>
          <div className="rounded-lg border border-border-strong p-1" id="cleanup-after">
            <p className="text-[11px] text-text-muted">{t('cleanup.after')}</p>
          </div>
        </div>
      </div>
    </WorkspaceShell>
  );
}
