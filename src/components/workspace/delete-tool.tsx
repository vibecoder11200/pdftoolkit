import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { engine } from '../../engine/client';
import { downloadBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { ThumbnailStrip } from './thumbnail-strip';

let uid = 0;

function newKey(p: number, gen: number): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  uid += 1;
  return `remove-${gen}-${p}-u${uid}`;
}

export function DeleteTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [fileSize, setFileSize] = useState<number>(0);
  const [numPages, setNumPages] = useState<number>(0);
  const [keys, setKeys] = useState<string[]>([]);
  const [deselected, setDeselected] = useState<Set<number>>(new Set());
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const genRef = useRef(0);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';

  const loadInfo = useCallback(async (data: Uint8Array) => {
    const gen = (genRef.current += 1);
    const { info } = await engine.loadPdf(data);
    if (genRef.current !== gen) return;
    setNumPages(info.numPages);
    setKeys(Array.from({ length: info.numPages }, (_, i) => newKey(i + 1, gen)));
    setDeselected(new Set());
  }, []);

  // Single-file input: keep only the first dropped file.
  useEffect(() => {
    const first = files[0];
    if (!first) {
      setBytes(null);
      setFileName('');
      setFileSize(0);
      setNumPages(0);
      setKeys([]);
      setDeselected(new Set());
      setThumbs({});
      return;
    }
    setBytes(first.bytes);
    setFileName(first.file.name);
    setFileSize(first.file.size);
    setRunError(null);
    void loadInfo(first.bytes).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      setRunError(t('remove.err_failed', { message }));
    });
  }, [files, loadInfo]);

  useEffect(() => {
    const abort = new AbortController();
    const renderAll = async () => {
      if (!bytes || numPages === 0) return;
      const { renderPageToCanvas } = await import('../../engine/pdfjs');
      const next: Record<string, string> = {};
      for (let p = 1; p <= Math.min(numPages, 60); p += 1) {
        if (abort.signal.aborted) return;
        try {
          const canvas = document.createElement('canvas');
          await renderPageToCanvas(bytes, p, canvas, 0.4);
          const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
          if (!blob || abort.signal.aborted) return;
          next[keys[p - 1]] = URL.createObjectURL(blob);
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
    if (bytes && numPages > 0) void renderAll();
    return () => abort.abort();
  }, [bytes, numPages, keys]);

  const toRemove = [...deselected].sort((a, b) => b - a);
  const keptCount = numPages - deselected.size;

  const applyDelete = async () => {
    setRunError(null);
    if (!bytes || toRemove.length === 0) return;
    if (keptCount < 1) {
      setRunError(t('remove.err_keep_one'));
      return;
    }
    const gen = genRef.current;
    try {
      setProgress({ value: 30, label: t('remove.progress_working', { count: toRemove.length }) });
      const out = await engine.removePages(bytes, toRemove);
      // Preview updates immediately: reload info into local state.
      const { info } = await engine.loadPdf(out);
      if (genRef.current !== gen) return;
      const ngen = (genRef.current += 1);
      setBytes(out);
      setFileSize(out.byteLength);
      setNumPages(info.numPages);
      setKeys(Array.from({ length: info.numPages }, (_, i) => newKey(i + 1, ngen)));
      setDeselected(new Set());
      setProgress({ value: 100, label: t('remove.progress_done') });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRunError(t('remove.err_failed', { message }));
      setProgress(null);
    }
  };

  const save = () => {
    if (!bytes) return;
    downloadBytes(bytes, fileName ? fileName.replace(/\.pdf$/i, '-removed.pdf') : 'removed.pdf');
  };

  return (
    <WorkspaceShell
      title={t('remove.title')}
      meta={
        bytes
          ? lng === 'vi'
            ? `1 file · ${keptCount} trang · ${formatBytes(fileSize, 'vi-VN')}`
            : `1 file · ${keptCount} pages · ${formatBytes(fileSize, 'en-US')}`
          : undefined
      }
      steps={[
        { label: '1', state: bytes ? 'done' : 'now' },
        { label: '2', state: bytes ? 'now' : 'todo' },
        { label: '3', state: 'todo' },
      ]}
      error={fileError ?? runError}
      side={
        <>
          <Button onClick={() => void applyDelete()} disabled={!bytes || toRemove.length === 0 || keptCount < 1}>
            {t('remove.cta_delete')}
          </Button>
          <Button
            variant="secondary"
            onClick={save}
            disabled={!bytes}
          >
            {t('remove.cta_save')}
          </Button>
          {progress ? null : (
            <span className="text-[13px] text-slate-500">{t('remove.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={() => {
        clear();
        setBytes(null);
        setFileName('');
        setFileSize(0);
        setNumPages(0);
        setKeys([]);
        setDeselected(new Set());
        setProgress(null);
        setRunError(null);
      }}
      onReselectAll={() => setDeselected(new Set())}
    >
      <Dropzone
        title={t('remove.dropzone_title')}
        hint={t('remove.dropzone_hint')}
        accept="application/pdf,.pdf"
        multiple={false}
        onFiles={(f) => void add(f.slice(0, 1))}
      />
      {numPages > 0 ? (
        <>
          <div className="mt-3.5 mb-2.5 flex flex-wrap items-center gap-2 text-[13px] text-slate-500">
            <span className="font-bold text-slate-900">
              {t('remove.keep_count', { count: keptCount })}
            </span>
            <span>· {t('remove.thumb_hint')}</span>
          </div>
          <ThumbnailStrip
            pages={keys.map((key, idx) => ({
              key,
              pageNumber: idx + 1,
              url: thumbs[key] ?? null,
              selected: !deselected.has(idx + 1),
            }))}
            fullscreenTitle={(n) => t('remove.fs_title', { n })}
            closeLabel={t('remove.fs_close')}
            onToggle={(pageNumber: number) => {
              setDeselected((prev) => {
                const next = new Set(prev);
                if (next.has(pageNumber)) {
                  next.delete(pageNumber);
                } else {
                  // Keep at least 1 page selected.
                  if (prev.size + 1 >= numPages) return prev;
                  next.add(pageNumber);
                }
                return next;
              });
            }}
          />
        </>
      ) : null}
    </WorkspaceShell>
  );
}
