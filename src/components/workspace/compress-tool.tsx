import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { pickDirectory } from '../../lib/dir-picker';
import { takePendingFiles } from '../../lib/handoff';
import { engine, getWorker } from '../../engine/client';
import { deliverBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Hint } from '../ui/hint';
import { ErrorBanner } from '../ui/error-banner';
import { Button } from '../ui/button';
import { SaveElsewhereButton } from '../ui/save-elsewhere-button';
import { WorkspaceShell } from './workspace-shell';
import { ContinueChip } from './continue-chip';
import { PresetBanner } from './preset-banner';
import { presetDefaultsFor } from '../../lib/preset-session';
import { useLastOutput } from '../../hooks/use-last-output';
import {
  MAX_FULL_PASSES,
  runTargetCompress,
  type TargetVerdict,
} from '../../lib/target-compress';
import { FileIcon } from '../ui/icons';

type CompressMode = 'vector' | 'image' | 'linearize' | 'target';
type ImageQuality = 'balanced' | 'small';
type TargetPreset = '500kb' | '1mb' | '2mb' | '5mb' | 'custom';

// `jpeg` is the mozjpeg quality on the worker's 1-100 scale (phase 7 — the
// 0-1 canvas.toBlob value of the same name was 75/60 in hundredths).
const QUALITY_PRESET: Record<ImageQuality, { scale: number; jpeg: number }> = {
  balanced: { scale: 1.5, jpeg: 75 },
  small: { scale: 1.0, jpeg: 60 },
};

// Target-mode size presets + the 100KB validation floor (plan phase-01).
const TARGET_PRESET_BYTES: Record<Exclude<TargetPreset, 'custom'>, number> = {
  '500kb': 500 * 1024,
  '1mb': 1024 * 1024,
  '2mb': 2 * 1024 * 1024,
  '5mb': 5 * 1024 * 1024,
};
const TARGET_MIN_BYTES = 100 * 1024;
// Sample AND full-pass renders cap the long edge at 4500px (scan-cleanup
// parity) — the anti-OOM bound the search's memory budget relies on.
const TARGET_MAX_EDGE = 4500;

// Per-mode "worth it" thresholds, in percent saved.
const VECTOR_THRESHOLD_PCT = 5;
const IMAGE_THRESHOLD_PCT = 10;

const ENCODE_FAILED = 'jpeg-encode-failed';

interface PageSize {
  width: number;
  height: number;
}

interface CompressResult {
  mode: CompressMode;
  bytes: Uint8Array | null;
  beforeBytes: number;
  afterBytes: number;
  savedPct: number;
  filename: string;
  /** Target-mode verdict metadata (mode 'target' only). */
  target?: {
    verdict: TargetVerdict;
    targetBytes: number;
    quality: number;
    scale: number;
    passesUsed: number;
  };
}

interface RunError {
  key: string;
  values?: Record<string, string | number>;
}

function outputName(original: string, mode: CompressMode): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'compressed';
  if (mode === 'vector') return `${base}-vector-pack.pdf`;
  if (mode === 'linearize') return `${base}-web.pdf`;
  if (mode === 'target') return `${base}-target.pdf`;
  return `${base}-raster.pdf`;
}

function thresholdKey(mode: CompressMode, pct: number): string {
  if (pct < 0) return 'compress.result_larger';
  if (mode === 'vector') {
    return pct < VECTOR_THRESHOLD_PCT ? 'compress.result_low_vector' : 'compress.result_ok_vector';
  }
  if (mode === 'linearize') return 'compress.result_ok_linearize';
  return pct < IMAGE_THRESHOLD_PCT ? 'compress.result_low_image' : 'compress.result_ok_image';
}

export function CompressTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  const { lastOutput, keep } = useLastOutput();
  // Home-sheet handoff. Single-file tool: only the first pending file applies.
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);
  // Preset-chain prefill (v0.8.1 phase 4): read ONCE at mount — the user can
  // still change the mode before running.
  const [mode, setMode] = useState<CompressMode>(
    () => presetDefaultsFor('compress')?.mode ?? 'vector',
  );
  const [quality, setQuality] = useState<ImageQuality>('balanced');
  // Target mode (v0.13.0 phase 1): size preset + custom MB input.
  const [targetPreset, setTargetPreset] = useState<TargetPreset>('1mb');
  const [targetCustomMb, setTargetCustomMb] = useState('1');
  const targetBytes = (() => {
    if (targetPreset !== 'custom') return TARGET_PRESET_BYTES[targetPreset];
    const mb = Number.parseFloat(targetCustomMb);
    if (!Number.isFinite(mb)) return TARGET_MIN_BYTES;
    return Math.max(TARGET_MIN_BYTES, Math.round(mb * 1024 * 1024));
  })();
  // Validation surface for the custom MB input (the bytes value itself is
  // clamped as a backstop); run stays blocked while the raw input is below
  // the 100KB floor.
  const targetInvalid =
    targetPreset === 'custom' &&
    Number.parseFloat(targetCustomMb) * 1024 * 1024 < TARGET_MIN_BYTES;
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const pickFolder = () => {
    void (async () => {
      const outcome = await pickDirectory(['.pdf']);
      if (!outcome.ok) {
        setBatchNote(t('home.batch_too_large', { size: formatBytes(outcome.totalBytes, locale) }));
        return;
      }
      if (outcome.files.length > 0) void add(outcome.files.slice(0, 1));
      setBatchNote(
        outcome.skippedEmpty > 0
          ? t('home.batch_skipped_empty', { count: outcome.skippedEmpty })
          : outcome.files.length === 0
            ? t('home.folder_empty')
            : null,
      );
    })();
  };

  const [numPages, setNumPages] = useState(0);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [result, setResult] = useState<CompressResult | null>(null);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<RunError | null>(null);
  const [loadErrorKey, setLoadErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';
  const locale = lng === 'vi' ? 'vi-VN' : 'en-US';

  const src = files.length > 0 ? files[0] : null;

  useEffect(() => {
    let cancelled = false;
    setLoadErrorKey(null);
    if (!src) {
      setNumPages(0);
      setPageSizes([]);
      return;
    }
    void (async () => {
      try {
        const { info } = await engine.loadPdf(src.bytes);
        if (cancelled) return;
        setNumPages(info.numPages);
        setPageSizes(info.pageInfos.map((p) => ({ width: p.width, height: p.height })));
      } catch {
        if (cancelled) return;
        setNumPages(0);
        setPageSizes([]);
        setLoadErrorKey('compress.error_load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  const finish = (out: Uint8Array, used: CompressMode, beforeBytes: number, fileName: string) => {
    const after = out.byteLength;
    const pct = beforeBytes > 0 ? ((beforeBytes - after) / beforeBytes) * 100 : 0;
    setResult({
      mode: used,
      bytes: out,
      beforeBytes,
      afterBytes: after,
      savedPct: pct,
      filename: outputName(fileName, used),
    });
    keep(out, outputName(fileName, used));
    setProgress({ value: 100, label: t('compress.progress_done') });
  };

  const run = async () => {
    setRunError(null);
    if (!src || numPages === 0) {
      setRunError({ key: 'compress.err_no_file' });
      return;
    }
    if (mode === 'target' && targetInvalid) {
      setRunError({ key: 'compress.target_invalid' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      if (mode === 'vector') {
        // Mode (a): qpdf --object-streams=generate. Text stays vector.
        setProgress({ value: 20, label: t('compress.progress_working_vector') });
        const out = await engine.compressVectorPack(src.bytes);
        finish(out, 'vector', src.bytes.byteLength, src.file.name);
      } else if (mode === 'linearize') {
        // Mode (c): fast web view — no compression, deliberately not chained
        // with the vector pack (one qpdf transform per run, per plan).
        setProgress({ value: 20, label: t('compress.progress_working_linearize') });
        const out = await engine.linearizePdf(src.bytes);
        finish(out, 'linearize', src.bytes.byteLength, src.file.name);
      } else if (mode === 'target') {
        // Mode (d) target-size (v0.13.0 phase 1): the SAME raster pipeline
        // as the image mode, driven by lib/target-compress's sample-
        // calibrated search. Deps are injected here so the lib stays pure.
        const { renderPageToCanvas, getPageVisualSize } = await import('../../engine/pdfjs');
        const { PDFDocument } = await import('pdf-lib');
        const inputSize = src.bytes.byteLength;
        const cappedRender = async (page: number, scale: number): Promise<ImageData> => {
          const { width, height } = await getPageVisualSize(src.bytes, page);
          const eff = Math.min(scale, TARGET_MAX_EDGE / Math.max(width, height));
          const canvas = document.createElement('canvas');
          await renderPageToCanvas(src.bytes, page, canvas, eff);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error(ENCODE_FAILED);
          return ctx.getImageData(0, 0, canvas.width, canvas.height);
        };
        const target = await runTargetCompress(inputSize, numPages, targetBytes, {
          renderImage: cappedRender,
          encodeJpeg: async (image, q) =>
            getWorker().encodeJpeg(
              { data: image.data, width: image.width, height: image.height },
              { quality: q, progressive: true },
            ),
          rebuild: async (jpegs) => {
            const doc = await PDFDocument.create();
            for (let i = 0; i < jpegs.length; i += 1) {
              const embedded = await doc.embedJpg(jpegs[i]);
              const size = pageSizes[i] ?? { width: embedded.width, height: embedded.height };
              const page = doc.addPage([size.width, size.height]);
              page.drawImage(embedded, { x: 0, y: 0, width: size.width, height: size.height });
            }
            return doc.save();
          },
          onProgress: (fraction, phase, pass) => {
            setProgress({
              value: Math.min(95, Math.round(fraction * 95)),
              label:
                phase === 'sample'
                  ? t('compress.target_progress_sample')
                  : phase === 'pass'
                    ? t('compress.target_progress_pass', { pass: pass ?? 1, max: MAX_FULL_PASSES })
                    : t('compress.target_progress_rebuild'),
            });
          },
        });
        // The verdict metadata rides the result card verbatim (both branches).
        const targetMeta = {
          verdict: target.verdict,
          targetBytes: target.targetBytes,
          quality: target.quality,
          scale: target.scale,
          passesUsed: target.passesUsed,
        };
        if (target.verdict === 'refuse-bigger') {
          // Honest refusal: every configuration outgrew the input — no
          // meaningless output (no bytes kept, no download buttons).
          setResult({
            mode: 'target',
            bytes: null,
            beforeBytes: inputSize,
            afterBytes: target.outSize,
            savedPct: ((inputSize - target.outSize) / inputSize) * 100,
            filename: outputName(src.file.name, 'target'),
            target: targetMeta,
          });
        } else {
          const out = target.bytes!;
          const after = out.byteLength;
          const name = outputName(src.file.name, 'target');
          setResult({
            mode: 'target',
            bytes: out,
            beforeBytes: inputSize,
            afterBytes: after,
            savedPct: ((inputSize - after) / inputSize) * 100,
            filename: name,
            target: targetMeta,
          });
          keep(out, name);
        }
        setProgress({ value: 100, label: t('compress.progress_done') });
      } else {
        // Mode (b): opt-in canvas downsample. Each page becomes a JPEG;
        // text selection is lost (explicit raster warning in the UI).
        const { renderPageToCanvas } = await import('../../engine/pdfjs');
        const { PDFDocument } = await import('pdf-lib');
        const preset = QUALITY_PRESET[quality];
        const images: Uint8Array[] = [];
        for (let p = 1; p <= numPages; p += 1) {
          setProgress({
            value: 10 + Math.round((70 * (p - 1)) / numPages),
            label: t('compress.progress_working_image', { done: p, total: numPages }),
          });
          const canvas = document.createElement('canvas');
          await renderPageToCanvas(src.bytes, p, canvas, preset.scale);
          // Phase 7 (D9 GO): mozjpeg encode in the worker instead of
          // canvas.toBlob — A/B measured 31-35% smaller at these preset
          // qualities (scripts/ab-mozjpeg.mjs).
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error(ENCODE_FAILED);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const encoded = await getWorker().encodeJpeg(
            { data: imageData.data, width: imageData.width, height: imageData.height },
            { quality: preset.jpeg, progressive: true },
          );
          if (encoded.byteLength === 0) throw new Error(ENCODE_FAILED);
          images.push(encoded);
        }
        setProgress({
          value: 85,
          label: t('compress.progress_working_image', { done: numPages, total: numPages }),
        });
        const doc = await PDFDocument.create();
        for (let i = 0; i < images.length; i += 1) {
          const embedded = await doc.embedJpg(images[i]);
          const size = pageSizes[i] ?? { width: embedded.width, height: embedded.height };
          const page = doc.addPage([size.width, size.height]);
          page.drawImage(embedded, { x: 0, y: 0, width: size.width, height: size.height });
        }
        const out = await doc.save();
        finish(out, 'image', src.bytes.byteLength, src.file.name);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === ENCODE_FAILED) {
        setRunError({ key: 'compress.err_encode' });
      } else {
        setRunError({ key: 'compress.err_failed', values: { message } });
      }
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const resetAll = () => {
    clear();
    keep(null, '');
    setNumPages(0);
    setPageSizes([]);
    setResult(null);
    setProgress(null);
    setRunError(null);
    setLoadErrorKey(null);
  };

  const fileErrorParts = (() => {
    if (!fileError) return null;
    const idx = fileError.indexOf(':');
    const code = idx === -1 ? fileError : fileError.slice(0, idx);
    const name = idx === -1 ? '' : fileError.slice(idx + 1);
    if (code === 'too-large') return { key: 'compress.err_too_large', values: { name } };
    if (code === 'not-pdf') return { key: 'compress.err_not_pdf', values: { name } };
    if (code === 'heic-refused') return { key: 'compress.err_heic', values: { name } };
    return null;
  })();

  const error = fileErrorParts
    ? t(fileErrorParts.key, fileErrorParts.values)
    : runError
      ? t(runError.key, runError.values)
      : loadErrorKey
        ? t(loadErrorKey)
        : null;

  const savedLabel =
    result == null
      ? null
      : result.savedPct < 0
        ? t('compress.result_grew', { pct: Math.abs(result.savedPct).toFixed(1) })
        : t('compress.result_saved', { pct: result.savedPct.toFixed(1) });

  // Target-mode verdict line — the honesty contract surfaced verbatim.
  const targetLine = (() => {
    if (!result || result.mode !== 'target' || !result.target) return null;
    const tg = result.target;
    const targetSize = formatBytes(tg.targetBytes, locale);
    const outSize = formatBytes(result.afterBytes, locale);
    if (tg.verdict === 'met') {
      return t('compress.target_result_met', { target: targetSize, size: outSize });
    }
    if (tg.verdict === 'best-effort') {
      return t('compress.target_result_best_effort', { target: targetSize, size: outSize });
    }
    return t('compress.target_result_refuse_bigger', { target: targetSize, size: outSize });
  })();

  return (
    <WorkspaceShell
      title={t('compress.title')}
      meta={
        src
          ? t('meta.file_pages', {
              name: src.file.name,
              count: numPages,
              size: formatBytes(src.file.size, locale),
            })
          : undefined
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: src ? 'done' : 'now' },
        { key: 'configure', label: t('steps.configure'), state: result ? 'done' : src ? 'now' : 'todo' },
        { key: 'download', label: t('steps.download'), state: result ? 'now' : 'todo' },
      ]}
      error={error}
      side={
        <>
          <Button
            onClick={() => void run()}
            disabled={!src || numPages === 0 || busy || targetInvalid}
            disabledReason={t('a11y.need_file')}
          >
            {t('compress.cta')}
          </Button>
          {lastOutput ? (
            <ContinueChip bytes={lastOutput.bytes} filename={lastOutput.filename} />
          ) : null}
          {progress ? null : (
            <span className="text-[13px] text-text-muted">{t('compress.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={resetAll}
    >
      <PresetBanner toolSlug="compress" output={lastOutput} />
      <Dropzone
        title={t('compress.dropzone_title')}
        hint={t('compress.dropzone_hint')}
        accept="application/pdf,.pdf"
        multiple={false}
        onFiles={(f) => {
          if (f.length === 0) return;
          clear();
          void add([f[0]]);
        }}
        footer={
          <button
            type="button"
            className="min-h-9 rounded-lg border border-border-strong px-3 text-[13px] text-text-muted hover:bg-surface-hover hover:text-text-primary"
            onClick={pickFolder}
          >
            {t('home.pick_folder')}
          </button>
        }
      />
      {batchNote ? <ErrorBanner error={batchNote} /> : null}
      {src ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-border-default p-2.5 text-[13.5px]">
          <span className="text-text-muted"><FileIcon size={17} /></span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{src.file.name}</span>
          <span className="ml-auto text-xs whitespace-nowrap text-text-muted tabular-nums">
            {formatBytes(src.file.size, locale)} · {t('units.pages', { count: numPages })}
          </span>
        </div>
      ) : null}
      <div className="mt-4 flex flex-col gap-2">
        <Hint variant="info" dismissKey="hint-compress-size">{t('compress.size_recommend')}</Hint>
        <Hint variant="info" dismissKey="hint-compress-modes">{t('compress.modes_hint')}</Hint>
      </div>
      <fieldset className="mt-4">
        <legend className="text-sm font-bold">{t('compress.mode_q')}</legend>
        <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label={t('compress.mode_q')}>
          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
              mode === 'vector' ? 'border-accent bg-surface-card' : 'border-border-strong bg-surface-card'
            }`}
          >
            <input
              type="radio"
              name="compress-mode"
              value="vector"
              checked={mode === 'vector'}
              onChange={() => setMode('vector')}
              className="mt-1 h-4 w-4 accent-accent"
            />
            <span>
              <span className="block font-semibold">{t('compress.mode_vector')}</span>
              <span className="block text-[13px] text-text-muted">{t('compress.mode_vector_hint')}</span>
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
              mode === 'image' ? 'border-accent bg-surface-card' : 'border-border-strong bg-surface-card'
            }`}
          >
            <input
              type="radio"
              name="compress-mode"
              value="image"
              checked={mode === 'image'}
              onChange={() => setMode('image')}
              className="mt-1 h-4 w-4 accent-accent"
            />
            <span>
              <span className="block font-semibold">{t('compress.mode_image')}</span>
              <span className="block text-[13px] text-text-muted">{t('compress.mode_image_hint')}</span>
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
              mode === 'linearize' ? 'border-accent bg-surface-card' : 'border-border-strong bg-surface-card'
            }`}
          >
            <input
              type="radio"
              name="compress-mode"
              value="linearize"
              checked={mode === 'linearize'}
              onChange={() => setMode('linearize')}
              className="mt-1 h-4 w-4 accent-accent"
            />
            <span>
              <span className="block font-semibold">{t('compress.mode_linearize')}</span>
              <span className="block text-[13px] text-text-muted">{t('compress.mode_linearize_hint')}</span>
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
              mode === 'target' ? 'border-accent bg-surface-card' : 'border-border-strong bg-surface-card'
            }`}
          >
            <input
              type="radio"
              name="compress-mode"
              value="target"
              checked={mode === 'target'}
              onChange={() => setMode('target')}
              className="mt-1 h-4 w-4 accent-accent"
            />
            <span>
              <span className="block font-semibold">{t('compress.mode_target')}</span>
              <span className="block text-[13px] text-text-muted">{t('compress.mode_target_hint')}</span>
            </span>
          </label>
        </div>
        {mode === 'image' || mode === 'target' ? (
          <div
            className="mt-2 rounded-lg border border-warning bg-warning-soft px-4 py-3 text-[13.5px]"
            role="note"
          >
            <strong className="block text-warning">{t('compress.raster_title')}</strong>
            <span className="text-warning">{t('compress.raster_warning')}</span>
          </div>
        ) : null}
      </fieldset>
      {mode === 'target' ? (
        <fieldset className="mt-4" data-testid="compress-target-size">
          <legend className="text-sm font-bold">{t('compress.target_size_q')}</legend>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              aria-label={t('compress.target_size_q')}
              value={targetPreset}
              onChange={(e) => setTargetPreset(e.target.value as TargetPreset)}
              className="min-h-11 rounded-lg border border-border-strong bg-surface-card px-3 text-[13px]"
            >
              <option value="500kb">500 KB</option>
              <option value="1mb">1 MB</option>
              <option value="2mb">2 MB</option>
              <option value="5mb">5 MB</option>
              <option value="custom">{t('compress.target_size_custom')}</option>
            </select>
            {targetPreset === 'custom' ? (
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  inputMode="decimal"
                  aria-label={t('compress.target_size_custom')}
                  value={targetCustomMb}
                  onChange={(e) => setTargetCustomMb(e.target.value)}
                  className="min-h-11 w-24 rounded-lg border border-border-strong bg-surface-card px-3 text-[13px]"
                />
                <span className="text-text-muted">MB</span>
              </label>
            ) : null}
          </div>
          {targetInvalid ? (
            <p role="alert" className="mt-1.5 text-[13px] text-danger">
              {t('compress.target_invalid')}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {mode === 'image' ? (
        <fieldset className="mt-4">
          <legend className="text-sm font-bold">{t('compress.quality_q')}</legend>
          <div
            className="mt-2 flex flex-col gap-2"
            role="radiogroup"
            aria-label={t('compress.quality_q')}
          >
            {(['balanced', 'small'] as ImageQuality[]).map((q) => (
              <label
                key={q}
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
                  quality === q ? 'border-accent bg-surface-card' : 'border-border-strong bg-surface-card'
                }`}
              >
                <input
                  type="radio"
                  name="compress-quality"
                  value={q}
                  checked={quality === q}
                  onChange={() => setQuality(q)}
                  className="mt-1 h-4 w-4 accent-accent"
                />
                <span>
                  <span className="block font-semibold">{t(`compress.quality_${q}`)}</span>
                  <span className="block text-[13px] text-text-muted">
                    {t(`compress.quality_${q}_hint`)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {result && savedLabel ? (
        <section
          aria-live="polite"
          className="mt-4 rounded-lg border border-border-default bg-surface-page px-4 py-3.5 text-[13.5px]"
        >
          <strong className="block text-text-primary">{t('compress.result_title')}</strong>
          <p className="mt-1.5 tabular-nums">
            {t('compress.result_before')}: {formatBytes(result.beforeBytes, locale)} →{' '}
            {t('compress.result_after')}: {formatBytes(result.afterBytes, locale)} · {savedLabel}
          </p>
          {result.target ? (
            <>
              <p
                className={`mt-1.5 ${
                  result.target.verdict === 'met'
                    ? 'text-text-primary'
                    : 'font-semibold text-warning'
                }`}
                data-testid="compress-target-verdict"
              >
                {targetLine}
              </p>
              <p className="mt-1.5 text-text-muted">
                {t('compress.target_used_config', {
                  quality: Math.round(result.target.quality),
                  scale: result.target.scale,
                  passes: result.target.passesUsed,
                })}
              </p>
            </>
          ) : (
            <p className="mt-1.5 text-text-muted">
              {t(thresholdKey(result.mode, result.savedPct), {
                pct: Math.abs(result.savedPct).toFixed(1),
              })}
            </p>
          )}
          {result.bytes ? (
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button onClick={() => void deliverBytes(result.bytes!, result.filename, 'download')}>
                {t('compress.download_cta')}
              </Button>
              <SaveElsewhereButton
                onClick={() => void deliverBytes(result.bytes!, result.filename, 'pick')}
              />
            </div>
          ) : null}
        </section>
      ) : null}
    </WorkspaceShell>
  );
}

// token-mapped
