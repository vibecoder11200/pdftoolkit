import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { takePendingFiles } from '../../lib/handoff';
import { engine } from '../../engine/client';
import { downloadBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';

type CompressMode = 'vector' | 'image';
type ImageQuality = 'balanced' | 'small';

const QUALITY_PRESET: Record<ImageQuality, { scale: number; jpeg: number }> = {
  balanced: { scale: 1.5, jpeg: 0.75 },
  small: { scale: 1.0, jpeg: 0.6 },
};

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
  bytes: Uint8Array;
  beforeBytes: number;
  afterBytes: number;
  savedPct: number;
  filename: string;
}

interface RunError {
  key: string;
  values?: Record<string, string | number>;
}

function outputName(original: string, mode: CompressMode): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'compressed';
  return mode === 'vector' ? `${base}-vector-pack.pdf` : `${base}-raster.pdf`;
}

function thresholdKey(mode: CompressMode, pct: number): string {
  if (pct < 0) return 'compress.result_larger';
  if (mode === 'vector') {
    return pct < VECTOR_THRESHOLD_PCT ? 'compress.result_low_vector' : 'compress.result_ok_vector';
  }
  return pct < IMAGE_THRESHOLD_PCT ? 'compress.result_low_image' : 'compress.result_ok_image';
}

export function CompressTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  // Home-sheet handoff. Single-file tool: only the first pending file applies.
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);
  const [mode, setMode] = useState<CompressMode>('vector');
  const [quality, setQuality] = useState<ImageQuality>('balanced');
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
    setProgress({ value: 100, label: t('compress.progress_done') });
  };

  const run = async () => {
    setRunError(null);
    if (!src || numPages === 0) {
      setRunError({ key: 'compress.err_no_file' });
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
          const blob = await new Promise<Blob | null>((res) =>
            canvas.toBlob(res, 'image/jpeg', preset.jpeg),
          );
          if (!blob) throw new Error(ENCODE_FAILED);
          images.push(new Uint8Array(await blob.arrayBuffer()));
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

  return (
    <WorkspaceShell
      title={t('compress.title')}
      meta={
        src
          ? lng === 'vi'
            ? `${src.file.name} · ${numPages} trang · ${formatBytes(src.file.size, 'vi-VN')}`
            : `${src.file.name} · ${numPages} pages · ${formatBytes(src.file.size, 'en-US')}`
          : undefined
      }
      steps={[
        { label: '1', state: src ? 'done' : 'now' },
        { label: '2', state: result ? 'done' : src ? 'now' : 'todo' },
        { label: '3', state: result ? 'now' : 'todo' },
      ]}
      error={error}
      side={
        <>
          <Button onClick={() => void run()} disabled={!src || numPages === 0 || busy}>
            {t('compress.cta')}
          </Button>
          {progress ? null : (
            <span className="text-[13px] text-text-muted">{t('compress.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={resetAll}
    >
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
      />
      {src ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-border-default p-2.5 text-[13.5px]">
          <span>📄</span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{src.file.name}</span>
          <span className="ml-auto text-xs whitespace-nowrap text-text-muted tabular-nums">
            {formatBytes(src.file.size, locale)} · {numPages} {lng === 'vi' ? 'trang' : 'pages'}
          </span>
        </div>
      ) : null}
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
        </div>
        <div
          className="mt-2 rounded-lg border border-warning bg-warning-soft px-4 py-3 text-[13.5px]"
          role="note"
        >
          <strong className="block text-warning">{t('compress.raster_title')}</strong>
          <span className="text-warning">{t('compress.raster_warning')}</span>
        </div>
      </fieldset>
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
          <p className="mt-1.5 text-text-muted">
            {t(thresholdKey(result.mode, result.savedPct), {
              pct: Math.abs(result.savedPct).toFixed(1),
            })}
          </p>
          <div className="mt-2.5">
            <Button onClick={() => downloadBytes(result.bytes, result.filename)}>
              {t('compress.download_cta')}
            </Button>
          </div>
        </section>
      ) : null}
    </WorkspaceShell>
  );
}

// token-mapped
