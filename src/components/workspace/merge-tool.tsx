import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { pickDirectory } from '../../lib/dir-picker';
import { takePendingFiles } from '../../lib/handoff';
import { useThumbnails } from '../../hooks/use-thumbnails';
import { engine } from '../../engine/client';
import { canSaveElsewhere, deliverBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { ErrorBanner } from '../ui/error-banner';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { FileIcon, XIcon } from '../ui/icons';
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
  // Files handed off from the home suggestion sheet. takePendingFiles is
  // one-shot, so StrictMode's double-invoked effect adds nothing twice.
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken) void add(taken.files);
  }, [add]);
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const pickFolder = () => {
    void (async () => {
      const outcome = await pickDirectory(['.pdf']);
      if (!outcome.ok) {
        setBatchNote(t('home.batch_too_large', { size: formatBytes(outcome.totalBytes, lng === 'vi' ? 'vi-VN' : 'en-US') }));
        return;
      }
      if (outcome.files.length > 0) void add(outcome.files);
      setBatchNote(
        outcome.skippedEmpty > 0
          ? t('home.batch_skipped_empty', { count: outcome.skippedEmpty })
          : outcome.files.length === 0
            ? t('home.folder_empty')
            : null,
      );
    })();
  };

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

  const run = async (dest: 'download' | 'pick' = 'download') => {
    setRunError(null);
    if (kept.length === 0 || files.length === 0) return;
    try {
      setProgress({ value: 20, label: t('merge.progress_working', { count: kept.length }) });
      const picks: number[][] = files.map((_, fi) =>
        kept.filter((p) => p.fileIndex === fi).map((p) => p.pageInFile),
      );
      const parts = files.map((f) => f.bytes);
      const out = await engine.mergeSelected(parts, picks);
      if (await deliverBytes(out, 'merged.pdf', dest)) {
        setProgress({ value: 100, label: t('merge.progress_done') });
      } else {
        setProgress(null); // picker cancelled — not an error
      }
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
        t('meta.files_pages', {
          files: t('units.files', { count: files.length }),
          count: kept.length,
          size: formatBytes(totalBytes, lng === 'vi' ? 'vi-VN' : 'en-US'),
        })
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: 'done' },
        { key: 'configure', label: t('steps.configure'), state: 'now' },
        { key: 'download', label: t('steps.download'), state: 'todo' },
      ]}
      error={fileError ?? runError}
      side={
        <>
          <Button onClick={() => void run()} disabled={kept.length === 0}>
            {t('merge.cta')}
          </Button>
          {canSaveElsewhere() ? (
            <Button variant="secondary" disabled={kept.length === 0} onClick={() => void run('pick')}>
              {t('save_elsewhere')}
            </Button>
          ) : null}
          {progress ? null : (
            <span className="text-[13px] text-text-muted">{t('merge.progress_idle')}</span>
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
              key={`${f.file.name}-${i}`}
              className="flex items-center gap-2.5 rounded-lg border border-border-default p-2.5 text-[13.5px]"
            >
              <span className="text-text-muted"><FileIcon size={17} /></span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{f.file.name}</span>
              <span className="ml-auto text-xs whitespace-nowrap text-text-muted tabular-nums">
                {formatBytes(f.file.size, lng === 'vi' ? 'vi-VN' : 'en-US')} ·{' '}
                {t('units.pages', { count: pageCounts[i] ?? 0 })}
              </span>
              <button
                type="button"
                aria-label={t('a11y.remove_file', { name: f.file.name })}
                className="min-h-10 min-w-10 text-text-muted hover:text-danger"
                onClick={() => removeAt(i)}
              >
                <XIcon />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {pages.length > 0 ? (
        <>
          <div className="mt-3.5 mb-2.5 flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
            <span className="font-bold text-text-primary">
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
            keyboardMoveHint={t('a11y.keyboard_move_hint')}
          />
        </>
      ) : null}
    </WorkspaceShell>
  );
}

// token-mapped
