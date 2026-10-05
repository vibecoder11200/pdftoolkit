import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { engine } from '../../engine/client';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
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

export function PdfToImgTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  const [numPages, setNumPages] = useState(0);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [format, setFormat] = useState<ImageFormat>('jpg');
  const [dpi, setDpi] = useState<number>(DEFAULT_DPI);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runErrorKey, setRunErrorKey] = useState<string | null>(null);
  const [loadErrorKey, setLoadErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const genRef = useRef(0);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';

  const src = files.length > 0 ? files[0] : null;

  useEffect(() => {
    const gen = (genRef.current += 1);
    setLoadErrorKey(null);
    if (!src) {
      setNumPages(0);
      setThumbs({});
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
        setThumbs({});
        setLoadErrorKey('pdf_to_images.error_load');
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
        setThumbs((prev) => {
          for (const u of Object.values(prev)) URL.revokeObjectURL(u);
          return next;
        });
      }
    };
    if (src && numPages > 0) void renderAll();
    return () => abort.abort();
  }, [src, numPages]);

  const run = async () => {
    setRunErrorKey(null);
    if (!src || numPages === 0) {
      setRunErrorKey('pdf_to_images.error_no_file');
      return;
    }
    setBusy(true);
    try {
      const { renderPageToCanvas } = await import('../../engine/pdfjs');
      const scale = dpi / 72;
      const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
      const ext = format === 'jpg' ? 'jpg' : 'png';
      const stem = baseName(src.file.name);
      for (let p = 1; p <= numPages; p += 1) {
        setProgress({
          value: Math.round(((p - 1) / numPages) * 100),
          label: t('pdf_to_images.progress_working', { current: p, total: numPages }),
        });
        const canvas = document.createElement('canvas');
        await renderPageToCanvas(src.bytes, p, canvas, scale);
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, 0.92));
        if (!blob) throw new Error('encode failed');
        downloadBlob(blob, `${stem}-p${p}.${ext}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      setProgress({ value: 100, label: t('pdf_to_images.progress_done', { count: numPages }) });
    } catch {
      setRunErrorKey('pdf_to_images.error_save');
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const resetAll = () => {
    clear();
    setNumPages(0);
    setThumbs({});
    setProgress(null);
    setRunErrorKey(null);
    setLoadErrorKey(null);
  };

  const error =
    fileError ?? (runErrorKey ? t(runErrorKey) : null) ?? (loadErrorKey ? t(loadErrorKey) : null);

  return (
    <WorkspaceShell
      title={t('pdf_to_images.title')}
      meta={
        src
          ? lng === 'vi'
            ? `${src.file.name} · ${numPages} trang · ${formatBytes(src.file.size, 'vi-VN')}`
            : `${src.file.name} · ${numPages} pages · ${formatBytes(src.file.size, 'en-US')}`
          : undefined
      }
      steps={[
        { label: '1', state: src ? 'done' : 'now' },
        { label: '2', state: src ? 'now' : 'todo' },
        { label: '3', state: 'todo' },
      ]}
      error={error}
      side={
        <>
          <fieldset>
            <legend className="text-sm font-bold">{t('pdf_to_images.format_q')}</legend>
            <div
              className="mt-2 flex flex-col gap-2"
              role="radiogroup"
              aria-label={t('pdf_to_images.format_q')}
            >
              {FORMATS.map((f) => (
                <label
                  key={f}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
                    format === f ? 'border-indigo-600 bg-white' : 'border-slate-300 bg-white'
                  }`}
                >
                  <input
                    type="radio"
                    name="pdf-to-img-format"
                    value={f}
                    checked={format === f}
                    onChange={() => setFormat(f)}
                    className="h-4 w-4 accent-indigo-600"
                  />
                  <span className="font-semibold">{t(`pdf_to_images.format_${f}`)}</span>
                  <span className="text-xs text-slate-500">{t(`pdf_to_images.format_${f}_hint`)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-sm font-bold">{t('pdf_to_images.dpi_q')}</legend>
            <div
              className="mt-2 grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label={t('pdf_to_images.dpi_q')}
            >
              {DPI_OPTIONS.map((d) => (
                <label
                  key={d}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                    dpi === d ? 'border-indigo-600 bg-white' : 'border-slate-300 bg-white'
                  }`}
                >
                  <input
                    type="radio"
                    name="pdf-to-img-dpi"
                    value={d}
                    checked={dpi === d}
                    onChange={() => setDpi(d)}
                    className="h-4 w-4 accent-indigo-600"
                  />
                  <span className="font-semibold tabular-nums">{d}</span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-slate-500">{t('pdf_to_images.dpi_hint')}</p>
          </fieldset>
          <Button onClick={() => void run()} disabled={!src || numPages === 0 || busy}>
            {t('pdf_to_images.cta')}
          </Button>
          {progress ? null : (
            <span className="text-[13px] text-slate-500">{t('pdf_to_images.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={resetAll}
    >
      <Dropzone
        title={t('pdf_to_images.dropzone_title')}
        hint={t('pdf_to_images.dropzone_hint')}
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
          <div className="mt-3.5 mb-2.5 flex flex-wrap items-center gap-2 text-[13px] text-slate-500">
            <span className="font-bold text-slate-900">
              {t('pdf_to_images.page_count', { count: numPages })}
            </span>
            <span>· {t('pdf_to_images.thumb_hint')}</span>
          </div>
          <ThumbnailStrip
            pages={Array.from({ length: numPages }, (_, i) => i + 1).map((n) => ({
              key: `pdf-to-img-${n}`,
              pageNumber: n,
              url: thumbs[n] ?? null,
              selected: true,
            }))}
            fullscreenTitle={(n) => t('pdf_to_images.fs_title', { n })}
            closeLabel={t('pdf_to_images.fs_close')}
            onToggle={() => {}}
          />
        </>
      ) : null}
    </WorkspaceShell>
  );
}
