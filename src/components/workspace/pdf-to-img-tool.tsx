import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { takePendingFiles } from '../../lib/handoff';
import { engine } from '../../engine/client';
import { downloadBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Hint } from '../ui/hint';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { ThumbnailStrip } from './thumbnail-strip';

type ImageFormat = 'jpg' | 'png';

const FORMATS: ImageFormat[] = ['jpg', 'png'];
const DPI_OPTIONS = [72, 150, 200, 300];
const DEFAULT_DPI = 150;
const THUMB_SCALE = 0.4;
const THUMB_CAP = 60;

function baseName(fileName: string): string {
  const stripped = fileName.replace(/\.pdf$/i, '');
  return stripped.trim() === '' ? 'pdf' : stripped;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

/** Thumb-state updater: installs `next`, revoking the replaced object URLs. */
function replaceThumbs(next: Record<number, string>) {
  return (prev: Record<number, string>): Record<number, string> => {
    for (const url of Object.values(prev)) URL.revokeObjectURL(url);
    return next;
  };
}

export function PdfToImgTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  // Home-sheet handoff (one-shot take; StrictMode's double effect adds nothing).
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);

  const [numPages, setNumPages] = useState(0);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [format, setFormat] = useState<ImageFormat>('jpg');
  const [dpi, setDpi] = useState<number>(DEFAULT_DPI);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runErrorKey, setRunErrorKey] = useState<string | null>(null);
  const [loadErrorKey, setLoadErrorKey] = useState<string | null>(null);
  const [zipOverflow, setZipOverflow] = useState(false);
  const [busy, setBusy] = useState(false);
  const genRef = useRef(0);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';

  const src = files.length > 0 ? files[0] : null;

  useEffect(() => {
    const gen = (genRef.current += 1);
    setLoadErrorKey(null);
    if (!src) {
      setNumPages(0);
      setThumbs(replaceThumbs({}));
      return;
    }
    void (async () => {
      try {
        const { info } = await engine.loadPdf(src.bytes);
        if (genRef.current !== gen) return;
        setNumPages(info.numPages);
      } catch {
        if (genRef.current !== gen) return;
        setNumPages(0);
        setThumbs(replaceThumbs({}));
        setLoadErrorKey('pdf-to-img.error_load');
      }
    })();
  }, [src]);

  useEffect(() => {
    const abort = new AbortController();
    const renderAll = async () => {
      if (!src) return;
      const { renderPageToCanvas } = await import('../../engine/pdfjs');
      const next: Record<number, string> = {};
      for (let p = 1; p <= Math.min(numPages, THUMB_CAP); p += 1) {
        if (abort.signal.aborted) return;
        try {
          const canvas = document.createElement('canvas');
          await renderPageToCanvas(src.bytes, p, canvas, THUMB_SCALE);
          const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
          if (!blob || abort.signal.aborted) return;
          next[p] = URL.createObjectURL(blob);
        } catch {
          /* keep placeholder */
        }
      }
      if (!abort.signal.aborted) {
        setThumbs(replaceThumbs(next));
      }
    };
    if (src && numPages > 0) void renderAll();
    return () => abort.abort();
  }, [src, numPages]);

  const renderAll = async (): Promise<{ name: string; bytes: Uint8Array }[]> => {
    const { renderPageToCanvas } = await import('../../engine/pdfjs');
    const scale = dpi / 72;
    const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const ext = format === 'jpg' ? 'jpg' : 'png';
    const stem = baseName(src!.file.name);
    const images: { name: string; bytes: Uint8Array }[] = [];
    for (let p = 1; p <= numPages; p += 1) {
      setProgress({
        value: Math.round(((p - 1) / numPages) * 90),
        label: t('pdf-to-img.progress_working', { current: p, total: numPages }),
      });
      const canvas = document.createElement('canvas');
      await renderPageToCanvas(src!.bytes, p, canvas, scale);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, 0.92));
      if (!blob) throw new Error('encode failed');
      images.push({ name: `${stem}-p${p}.${ext}`, bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    return images;
  };

  const run = async (kind: 'auto' | 'single' = 'auto') => {
    setRunErrorKey(null);
    setZipOverflow(false);
    if (!src || numPages === 0) {
      setRunErrorKey('pdf-to-img.error_no_file');
      return;
    }
    setBusy(true);
    try {
      const images = await renderAll();
      // Multi-page default: one ZIP via the worker (red-team #10). The 200MB
      // budget lives in zipStore; over budget → banner + automatic per-image
      // fallback instead of a dead end.
      if (kind === 'auto' && numPages > 1) {
        setProgress({ value: 95, label: t('pdf-to-img.progress_zip') });
        try {
          const zip = await engine.zipStore(images);
          downloadBytes(zip, `${baseName(src.file.name)}-images.zip`, 'application/zip');
          setProgress({ value: 100, label: t('pdf-to-img.progress_done', { count: numPages }) });
          return;
        } catch (e) {
          if ((e as Error).name !== 'ZipSizeError') throw e;
          setZipOverflow(true);
        }
      }
      for (const image of images) {
        downloadBlob(new Blob([image.bytes.slice().buffer as ArrayBuffer]), image.name);
        await new Promise((r) => setTimeout(r, 150));
      }
      setProgress({ value: 100, label: t('pdf-to-img.progress_done', { count: numPages }) });
    } catch {
      setRunErrorKey('pdf-to-img.error_save');
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const resetAll = () => {
    clear();
    setNumPages(0);
    setThumbs(replaceThumbs({}));
    setProgress(null);
    setRunErrorKey(null);
    setLoadErrorKey(null);
    setZipOverflow(false);
  };

  const error =
    fileError ??
    (zipOverflow ? t('pdf-to-img.zip_overflow') : null) ??
    (runErrorKey ? t(runErrorKey) : null) ??
    (loadErrorKey ? t(loadErrorKey) : null);

  return (
    <WorkspaceShell
      title={t('pdf-to-img.title')}
      meta={
        src
          ? t('meta.file_pages', {
                name: src.file.name,
                count: numPages,
                size: formatBytes(src.file.size, lng === 'vi' ? 'vi-VN' : 'en-US'),
              })
          : undefined
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: src ? 'done' : 'now' },
        { key: 'configure', label: t('steps.configure'), state: src ? 'now' : 'todo' },
        { key: 'download', label: t('steps.download'), state: 'todo' },
      ]}
      error={error}
      side={
        <>
          <fieldset>
            <legend className="text-sm font-bold">{t('pdf-to-img.format_q')}</legend>
            <div
              className="mt-2 flex flex-col gap-2"
              role="radiogroup"
              aria-label={t('pdf-to-img.format_q')}
            >
              {FORMATS.map((f) => (
                <label
                  key={f}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
                    format === f ? 'border-accent bg-surface-card' : 'border-border-strong bg-surface-card'
                  }`}
                >
                  <input
                    type="radio"
                    name="pdf-to-img-format"
                    value={f}
                    checked={format === f}
                    onChange={() => setFormat(f)}
                    className="h-4 w-4 accent-accent"
                  />
                  <span className="font-semibold">{t(`pdf-to-img.format_${f}`)}</span>
                  <span className="text-xs text-text-muted">{t(`pdf-to-img.format_${f}_hint`)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-sm font-bold">{t('pdf-to-img.dpi_q')}</legend>
            <div
              className="mt-2 grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label={t('pdf-to-img.dpi_q')}
            >
              {DPI_OPTIONS.map((d) => (
                <label
                  key={d}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                    dpi === d ? 'border-accent bg-surface-card' : 'border-border-strong bg-surface-card'
                  }`}
                >
                  <input
                    type="radio"
                    name="pdf-to-img-dpi"
                    value={d}
                    checked={dpi === d}
                    onChange={() => setDpi(d)}
                    className="h-4 w-4 accent-accent"
                  />
                  <span className="font-semibold tabular-nums">{d}</span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-text-muted">{t('pdf-to-img.dpi_hint')}</p>
          </fieldset>
          <Button onClick={() => void run('auto')} disabled={!src || numPages === 0 || busy}>
            {t('pdf-to-img.cta')}
          </Button>
          {numPages > 1 ? (
            <Button
              variant="secondary"
              onClick={() => void run('single')}
              disabled={!src || numPages === 0 || busy}
            >
              {t('pdf-to-img.single_cta')}
            </Button>
          ) : null}
          {numPages > 1 ? (
            <Hint variant="info" dismissKey="hint-pdf-to-img-zip">{t('pdf-to-img.zip_hint')}</Hint>
          ) : null}
          {progress ? null : (
            <span className="text-[13px] text-text-muted">{t('pdf-to-img.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={resetAll}
    >
      <Dropzone
        title={t('pdf-to-img.dropzone_title')}
        hint={t('pdf-to-img.dropzone_hint')}
        accept="application/pdf,.pdf"
        multiple={false}
        onFiles={(f) => {
          if (f.length === 0) return;
          clear();
          void add([f[0]]);
        }}
      />
      {numPages > 0 ? (
        <>
          <div className="mt-3.5 mb-2.5 flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
            <span className="font-bold text-text-primary">
              {t('pdf-to-img.page_count', { count: numPages })}
            </span>
            <span>· {t('pdf-to-img.thumb_hint')}</span>
          </div>
          <ThumbnailStrip
            pages={Array.from({ length: numPages }, (_, i) => i + 1).map((n) => ({
              key: `pdf-to-img-${n}`,
              pageNumber: n,
              url: thumbs[n] ?? null,
              selected: true,
            }))}
            fullscreenTitle={(n) => t('pdf-to-img.fs_title', { n })}
            closeLabel={t('pdf-to-img.fs_close')}
            onToggle={() => {}}
          />
        </>
      ) : null}
    </WorkspaceShell>
  );
}

// token-mapped
