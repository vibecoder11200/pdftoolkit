import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { useThumbnails } from '../../hooks/use-thumbnails';
import { engine } from '../../engine/client';
import { downloadBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { ThumbnailStrip } from './thumbnail-strip';

interface PageEntry {
  uuid: string;
  fileIndex: number;
  pageInFile: number;
}

let uid = 0;

function newUuid(fi: number, p: number, gen: number): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  uid += 1;
  return `merge-${gen}-${fi}-${p}-u${uid}`;
}

export function MergeTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, removeAt, clear } = useDropFiles();
  const [pages, setPages] = useState<PageEntry[]>([]);
  const [pageCounts, setPageCounts] = useState<number[]>([]);
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const genRef = useRef(0);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';

  const loadCounts = useCallback(async (list: { bytes: Uint8Array }[]) => {
    const gen = (genRef.current += 1);
    const counts: number[] = [];
    for (const f of list) {
      try {
        const { info } = await engine.loadPdf(f.bytes);
        counts.push(info.numPages);
      } catch {
        counts.push(0);
      }
    }
    if (genRef.current !== gen) return;
    const entries: PageEntry[] = [];
    counts.forEach((count, fi) => {
      for (let p = 1; p <= count; p += 1) {
        entries.push({ uuid: newUuid(fi, p, gen), fileIndex: fi, pageInFile: p });
      }
    });
    if (genRef.current !== gen) return;
    setPageCounts(counts);
    setPages(entries);
    setDeselected(new Set());
  }, []);

  useEffect(() => {
    void loadCounts(files.map((f) => ({ bytes: f.bytes })));
  }, [files, loadCounts]);

  const thumbJobs = pages.map((entry) => ({
    id: entry.uuid,
    bytes: files[entry.fileIndex].bytes,
    page: entry.pageInFile,
    version: 0,
  }));
  const { urlFor, observe } = useThumbnails(thumbJobs);

  const kept = pages.filter((p) => !deselected.has(p.uuid));
  const totalBytes = files.reduce((a, f) => a + f.file.size, 0);

  const run = async () => {
    setRunError(null);
    if (kept.length === 0 || files.length === 0) return;
    try {
      setProgress({ value: 20, label: t('merge.progress_working', { count: kept.length }) });
      const picks: number[][] = files.map((_, fi) =>
        kept.filter((p) => p.fileIndex === fi).map((p) => p.pageInFile),
      );
      const parts = files.map((f) => f.bytes);
      const out = await engine.mergeSelected(parts, picks);
      setProgress({ value: 100, label: t('merge.progress_done') });
      downloadBytes(out, 'merged.pdf');
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    }
  };

  const movePage = (fromGlobal: number, toGlobal: number) => {
    setPages((prev) => {
      const fi = fromGlobal - 1;
      const ti = toGlobal - 1;
      if (fi < 0 || ti < 0 || fi >= prev.length || ti >= prev.length) return prev;
      const arr = [...prev];
      const [moved] = arr.splice(fi, 1);
      arr.splice(ti, 0, moved);
      return arr;
    });
  };

  return (
    <WorkspaceShell
      title={t('merge.title')}
      meta={
        lng === 'vi'
          ? `${files.length} file · ${kept.length} trang · ${formatBytes(totalBytes, 'vi-VN')}`
          : `${files.length} files · ${kept.length} pages · ${formatBytes(totalBytes, 'en-US')}`
      }
      steps={[
        { label: '1', state: 'done' },
        { label: '2', state: 'now' },
        { label: '3', state: 'todo' },
      ]}
      error={fileError ?? runError}
      side={
        <>
          <Button onClick={() => void run()} disabled={kept.length === 0}>
            {t('merge.cta')}
          </Button>
          {progress ? null : (
            <span className="text-[13px] text-slate-500">{t('merge.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={() => {
        clear();
        setPages([]);
        setPageCounts([]);
        setDeselected(new Set());
        setProgress(null);
        setRunError(null);
      }}
      onReselectAll={() => setDeselected(new Set())}
    >
      <Dropzone
        title={t('merge.dropzone_title')}
        hint={t('merge.dropzone_hint')}
        accept="application/pdf,.pdf"
        onFiles={(f) => void add(f)}
      />
      {files.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {files.map((f, i) => (
            <div
              key={`${f.file.name}-${i}`}
              className="flex items-center gap-2.5 rounded-lg border border-slate-200 p-2.5 text-[13.5px]"
            >
              <span>📄</span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{f.file.name}</span>
              <span className="ml-auto text-xs whitespace-nowrap text-slate-500 tabular-nums">
                {formatBytes(f.file.size, lng === 'vi' ? 'vi-VN' : 'en-US')} ·{' '}
                {pageCounts[i] ?? 0} trang
              </span>
              <button
                type="button"
                aria-label={`Remove ${f.file.name}`}
                className="min-h-10 min-w-10 text-slate-500 hover:text-red-600"
                onClick={() => removeAt(i)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {pages.length > 0 ? (
        <>
          <div className="mt-3.5 mb-2.5 flex flex-wrap items-center gap-2 text-[13px] text-slate-500">
            <span className="font-bold text-slate-900">
              {t('merge.keep_count', { count: kept.length })}
            </span>
            <span>· {t('merge.thumb_hint')}</span>
          </div>
          <ThumbnailStrip
            pages={pages.map((p, idx) => ({
              key: p.uuid,
              pageNumber: idx + 1,
              url: urlFor(p.uuid),
              selected: !deselected.has(p.uuid),
            }))}
            fullscreenTitle={(n) => t('merge.fs_title', { n })}
            closeLabel={t('merge.fs_close')}
            register={observe}
            onToggle={(_pageNumber: number, idx: number) => {
              const entry = pages[idx];
              if (!entry) return;
              setDeselected((prev) => {
                const next = new Set(prev);
                if (next.has(entry.uuid)) next.delete(entry.uuid);
                else next.add(entry.uuid);
                return next;
              });
            }}
            onMove={(from, to) => movePage(from, to)}
          />
        </>
      ) : null}
    </WorkspaceShell>
  );
}
