import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PDFDocument, PageSizes } from 'pdf-lib';
import { MAX_FILE_BYTES } from '../../lib/file-accept';
import { pickDirectory } from '../../lib/dir-picker';
import { takePendingFiles } from '../../lib/handoff';
import { deliverBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { ErrorBanner } from '../ui/error-banner';
import { Button } from '../ui/button';
import { SaveElsewhereButton } from '../ui/save-elsewhere-button';
import { WorkspaceShell } from './workspace-shell';
import { XIcon } from '../ui/icons';

const ACCEPT = 'image/jpeg,.jpg,.jpeg,image/png,.png';
const JPEG_QUALITY = 0.92;

interface ToolError {
  key: string;
  values?: Record<string, string | number>;
}

function isHeic(file: File): boolean {
  return (
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    /\.(heic|heif)$/i.test(file.name)
  );
}

function isSupportedImage(file: File): boolean {
  if (file.type === 'image/jpeg' || file.type === 'image/png') return true;
  return /\.(jpe?g|png)$/i.test(file.name);
}

function isPng(file: File): boolean {
  if (file.type === 'image/png') return true;
  if (file.type === 'image/jpeg') return false;
  return /\.png$/i.test(file.name);
}

// Decode with EXIF orientation applied by the browser. Never parse EXIF manually.
async function decodeOriented(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(file);
  }
}

async function bitmapToBytes(bitmap: ImageBitmap, png: boolean): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  if (!png) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  const mime = png ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((res) =>
    png ? canvas.toBlob(res, mime) : canvas.toBlob(res, mime, JPEG_QUALITY),
  );
  if (!blob) throw new Error('encode failed');
  return new Uint8Array(await blob.arrayBuffer());
}

export function ImgToPdfTool() {
  const { t, i18n } = useTranslation();
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const pickFolder = () => {
    void (async () => {
      const outcome = await pickDirectory(['.jpg', '.jpeg', '.png']);
      if (!outcome.ok) {
        setBatchNote(t('home.batch_too_large', { size: formatBytes(outcome.totalBytes, locale) }));
        return;
      }
      if (outcome.files.length > 0) addFiles(outcome.files);
      setBatchNote(
        outcome.skippedEmpty > 0
          ? t('home.batch_skipped_empty', { count: outcome.skippedEmpty })
          : outcome.files.length === 0
            ? t('home.folder_empty')
            : null,
      );
    })();
  };

  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [error, setError] = useState<ToolError | null>(null);
  const [busy, setBusy] = useState(false);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';
  const locale = lng === 'vi' ? 'vi-VN' : 'en-US';

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [files]);

  const addFiles = (incoming: File[]) => {
    setError(null);
    const accepted: File[] = [];
    for (const file of incoming) {
      if (file.size > MAX_FILE_BYTES) {
        setError({ key: 'img-to-pdf.err_too_large', values: { name: file.name } });
        continue;
      }
      if (isHeic(file)) {
        setError({ key: 'img-to-pdf.err_heic', values: { name: file.name } });
        continue;
      }
      if (!isSupportedImage(file)) {
        setError({ key: 'img-to-pdf.err_not_image', values: { name: file.name } });
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
  };

  // Home-sheet handoff. addFiles re-validates (jpeg/png, size) the same way
  // the dropzone path does; one-shot take keeps StrictMode's double effect
  // from adding files twice. addFiles only touches state setters, so the
  // mount-once closure stays correct.
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) addFiles(taken.files);
  }, []);

  const removeAt = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const resetAll = () => {
    setFiles([]);
    setProgress(null);
    setError(null);
  };

  const run = async (dest: 'download' | 'pick' = 'download') => {
    setError(null);
    if (files.length === 0) {
      setError({ key: 'img-to-pdf.err_no_file' });
      return;
    }
    setBusy(true);
    try {
      const doc = await PDFDocument.create();
      const [pageW, pageH] = PageSizes.A4;
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        setProgress({
          value: Math.round((i / files.length) * 100),
          label: t('img-to-pdf.progress_working', { current: i + 1, total: files.length }),
        });
        const bitmap = await decodeOriented(file);
        try {
          if (bitmap.width === 0 || bitmap.height === 0) throw new Error('empty image');
          const png = isPng(file);
          const bytes = await bitmapToBytes(bitmap, png);
          const embedded = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          const scale = Math.min(pageW / bitmap.width, pageH / bitmap.height);
          const w = bitmap.width * scale;
          const h = bitmap.height * scale;
          const page = doc.addPage(PageSizes.A4);
          page.drawImage(embedded, {
            x: (pageW - w) / 2,
            y: (pageH - h) / 2,
            width: w,
            height: h,
          });
        } finally {
          bitmap.close();
        }
      }
      const out = await doc.save();
      if (await deliverBytes(out, 'images.pdf', dest)) {
        setProgress({ value: 100, label: t('img-to-pdf.progress_done', { count: files.length }) });
      } else {
        setProgress(null); // picker cancelled — not an error
      }
    } catch (e) {
      setError({
        key: 'img-to-pdf.err_failed',
        values: { message: e instanceof Error ? e.message : String(e) },
      });
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const totalBytes = files.reduce((a, f) => a + f.size, 0);

  return (
    <WorkspaceShell
      title={t('img-to-pdf.title')}
      meta={
        files.length > 0
          ? t('img-to-pdf.file_count', {
              count: files.length,
              size: formatBytes(totalBytes, locale),
            })
          : undefined
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: files.length > 0 ? 'done' : 'now' },
        { key: 'configure', label: t('steps.configure'), state: files.length > 0 ? 'now' : 'todo' },
        { key: 'download', label: t('steps.download'), state: 'todo' },
      ]}
      error={error ? t(error.key, error.values) : null}
      side={
        <>
          <Button onClick={() => void run()} disabled={files.length === 0 || busy}>
            {t('img-to-pdf.cta')}
          </Button>
          <SaveElsewhereButton
            disabled={files.length === 0 || busy}
            onClick={() => void run('pick')}
          />
          {progress ? null : (
            <span className="text-[13px] text-text-muted">{t('img-to-pdf.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={resetAll}
    >
      <Dropzone
        title={t('img-to-pdf.dropzone_title')}
        hint={t('img-to-pdf.dropzone_hint')}
        accept={ACCEPT}
        onFiles={(f) => addFiles(f)}
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
      {files.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {files.map((f, i) => (
            <div
              key={`${f.name}-${f.size}-${i}`}
              className="flex items-center gap-2.5 rounded-lg border border-border-default p-2.5 text-[13.5px]"
            >
              {previews[i] ? (
                <img
                  src={previews[i]}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded object-cover"
                />
              ) : (
                <span>🖼️</span>
              )}
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{f.name}</span>
              <span className="ml-auto text-xs whitespace-nowrap text-text-muted tabular-nums">
                {formatBytes(f.size, locale)}
              </span>
              <button
                type="button"
                aria-label={t('a11y.remove_file', { name: f.name })}
                className="min-h-10 min-w-10 text-text-muted hover:text-danger"
                onClick={() => removeAt(i)}
              >
                <XIcon />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </WorkspaceShell>
  );
}

// token-mapped
