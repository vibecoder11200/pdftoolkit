import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { engine } from '../../engine/client';
import { downloadBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { ThumbnailStrip } from './thumbnail-strip';

const THUMB_SCALE = 0.4;
const THUMB_CAP = 60;

export function ReorderTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  // `order` is the full permutation: display position -> original 1-based page.
  const [order, setOrder] = useState<number[]>([]);
  const [numPages, setNumPages] = useState(0);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runErrorKey, setRunErrorKey] = useState<string | null>(null);
  const [loadErrorKey, setLoadErrorKey] = useState<string | null>(null);
  const genRef = useRef(0);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';

  const src = files.length > 0 ? files[0] : null;

  useEffect(() => {
    const gen = (genRef.current += 1);
    setLoadErrorKey(null);
    if (!src) {
      setNumPages(0);
      setOrder([]);
      return;
    }
    void (async () => {
      try {
        const { info } = await engine.loadPdf(src.bytes);
        if (genRef.current !== gen) return;
        setNumPages(info.numPages);
        setOrder(Array.from({ length: info.numPages }, (_, i) => i + 1));
      } catch {
        if (genRef.current !== gen) return;
        setNumPages(0);
        setOrder([]);
        setLoadErrorKey('reorder.error_load');
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

  const move = (fromPos: number, toPos: number) => {
    setOrder((prev) => {
      const fi = fromPos - 1;
      const ti = toPos - 1;
      if (fi < 0 || ti < 0 || fi >= prev.length || ti >= prev.length) return prev;
      const arr = [...prev];
      const [moved] = arr.splice(fi, 1);
      arr.splice(ti, 0, moved);
      return arr;
    });
  };

  const step = (index: number, delta: -1 | 1) => {
    setOrder((prev) => {
      const j = index + delta;
      if (index < 0 || j < 0 || index >= prev.length || j >= prev.length) return prev;
      const arr = [...prev];
      [arr[index], arr[j]] = [arr[j], arr[index]];
      return arr;
    });
  };

  const run = async () => {
    setRunErrorKey(null);
    if (!src || order.length === 0) {
      setRunErrorKey('reorder.error_no_file');
      return;
    }
    try {
      setProgress({ value: 20, label: t('reorder.progress_working', { count: order.length }) });
      const out = await engine.reorderPages(src.bytes, order);
      setProgress({ value: 100, label: t('reorder.progress_done') });
      downloadBytes(out, 'reordered.pdf');
    } catch {
      setRunErrorKey('reorder.error_save');
      setProgress(null);
    }
  };

  const resetAll = () => {
    clear();
    setOrder([]);
    setNumPages(0);
    setProgress(null);
    setRunErrorKey(null);
    setLoadErrorKey(null);
  };

  const error = fileError ?? (runErrorKey ? t(runErrorKey) : null) ?? (loadErrorKey ? t(loadErrorKey) : null);

  return (
    <WorkspaceShell
      title={t('reorder.title')}
      meta={
        src
          ? lng === 'vi'
            ? `${src.file.name} · ${order.length} trang · ${formatBytes(src.file.size, 'vi-VN')}`
            : `${src.file.name} · ${order.length} pages · ${formatBytes(src.file.size, 'en-US')}`
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
          <Button onClick={() => void run()} disabled={!src || order.length === 0}>
            {t('reorder.cta')}
          </Button>
          {progress ? null : (
            <span className="text-[13px] text-slate-500">{t('reorder.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={resetAll}
      onReselectAll={() =>
        setOrder((prev) =>
          prev.length > 0
            ? Array.from({ length: prev.length }, (_, i) => i + 1)
            : Array.from({ length: numPages }, (_, i) => i + 1),
        )
      }
    >
      <Dropzone
        title={t('reorder.dropzone_title')}
        hint={t('reorder.dropzone_hint')}
        accept="application/pdf,.pdf"
        multiple={false}
        onFiles={(f) => {
          if (f.length === 0) return;
          clear();
          void add([f[0]]);
        }}
      />
      {order.length > 0 ? (
        <>
          <div className="mt-3.5 mb-2.5 flex flex-wrap items-center gap-2 text-[13px] text-slate-500">
            <span className="font-bold text-slate-900">
              {t('reorder.page_count', { count: order.length })}
            </span>
            <span>· {t('reorder.thumb_hint')}</span>
          </div>
          <ThumbnailStrip
            pages={order.map((orig, idx) => ({
              key: `reorder-${orig}`,
              pageNumber: idx + 1,
              url: thumbs[orig] ?? null,
              selected: true,
            }))}
            fullscreenTitle={(n) => t('reorder.fs_title', { n })}
            closeLabel={t('reorder.fs_close')}
            onToggle={() => {}}
            onMove={(from, to) => move(from, to)}
          />
          <ol className="mt-3 flex flex-col gap-2" aria-label={t('reorder.title')}>
            {order.map((orig, idx) => (
              <li
                key={`reorder-row-${orig}`}
                className="flex items-center gap-2 rounded-lg border border-slate-200 p-2 text-[13.5px]"
              >
                <span className="font-bold tabular-nums">
                  {t('reorder.position', { n: idx + 1 })}
                </span>
                <span className="text-slate-500">{t('reorder.source_page', { n: orig })}</span>
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    aria-label={t('reorder.move_up', { n: idx + 1 })}
                    disabled={idx === 0}
                    onClick={() => step(idx, -1)}
                    className="min-h-10 min-w-10 rounded-lg border border-slate-300 disabled:opacity-40"
                  >
                    {t('reorder.up')}
                  </button>
                  <button
                    type="button"
                    aria-label={t('reorder.move_down', { n: idx + 1 })}
                    disabled={idx === order.length - 1}
                    onClick={() => step(idx, 1)}
                    className="min-h-10 min-w-10 rounded-lg border border-slate-300 disabled:opacity-40"
                  >
                    {t('reorder.down')}
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </WorkspaceShell>
  );
}
