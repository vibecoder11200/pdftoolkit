import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { takePendingFiles } from '../../lib/handoff';
import { useThumbnails } from '../../hooks/use-thumbnails';
import { engine } from '../../engine/client';
import { downloadBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { ThumbnailStrip } from './thumbnail-strip';

export function ExtractTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  // Home-sheet handoff (one-shot take; StrictMode's double effect adds nothing).
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);

  const [numPages, setNumPages] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
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
      setSelected(new Set());
      return;
    }
    void (async () => {
      try {
        const { info } = await engine.loadPdf(src.bytes);
        if (genRef.current !== gen) return;
        setNumPages(info.numPages);
        setSelected(new Set());
      } catch {
        if (genRef.current !== gen) return;
        setNumPages(0);
        setSelected(new Set());
        setLoadErrorKey('extract.error_load');
      }
    })();
  }, [src]);

  const thumbJobs =
    src && numPages > 0
      ? Array.from({ length: numPages }, (_, i) => ({
          id: `p${i + 1}`,
          bytes: src.bytes,
          page: i + 1,
          version: genRef.current,
        }))
      : [];
  const { urlFor, observe } = useThumbnails(thumbJobs);

  const toggle = (pageNumber: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pageNumber)) next.delete(pageNumber);
      else next.add(pageNumber);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(Array.from({ length: numPages }, (_, i) => i + 1)));
  };

  const clearSelection = () => {
    setSelected(new Set());
  };

  const run = async () => {
    setRunErrorKey(null);
    if (!src || numPages === 0) {
      setRunErrorKey('extract.error_no_file');
      return;
    }
    if (selected.size === 0) {
      setRunErrorKey('extract.error_no_selection');
      return;
    }
    try {
      const targets = [...selected].sort((a, b) => a - b);
      setProgress({ value: 20, label: t('extract.progress_working', { count: targets.length }) });
      const out = await engine.extractPages(src.bytes, targets);
      setProgress({ value: 100, label: t('extract.progress_done') });
      downloadBytes(out, 'extracted.pdf');
    } catch {
      setRunErrorKey('extract.error_save');
      setProgress(null);
    }
  };

  const resetAll = () => {
    clear();
    setNumPages(0);
    setSelected(new Set());
    setProgress(null);
    setRunErrorKey(null);
    setLoadErrorKey(null);
  };

  const error =
    fileError ?? (runErrorKey ? t(runErrorKey) : null) ?? (loadErrorKey ? t(loadErrorKey) : null);

  return (
    <WorkspaceShell
      title={t('extract.title')}
      meta={
        src
          ? t('meta.file_selected_pages', {
              name: src.file.name,
              selected: selected.size,
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
          <Button onClick={() => void run()} disabled={!src || selected.size === 0}>
            {t('extract.cta')}
          </Button>
          <Button variant="secondary" onClick={selectAll} disabled={!src || numPages === 0}>
            {t('extract.select_all')}
          </Button>
          <Button variant="ghost" onClick={clearSelection} disabled={selected.size === 0}>
            {t('extract.clear_selection')}
          </Button>
          {progress ? null : (
            <span className="text-[13px] text-text-muted">{t('extract.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={resetAll}
      onReselectAll={numPages > 0 ? selectAll : undefined}
    >
      <Dropzone
        title={t('extract.dropzone_title')}
        hint={t('extract.dropzone_hint')}
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
              {t('extract.selected_count', { count: selected.size, total: numPages })}
            </span>
            <span>· {t('extract.thumb_hint')}</span>
          </div>
          <ThumbnailStrip
            pages={Array.from({ length: numPages }, (_, i) => i + 1).map((n) => ({
              key: `p${n}`,
              pageNumber: n,
              url: urlFor(`p${n}`),
              selected: selected.has(n),
            }))}
            fullscreenTitle={(n) => t('extract.fs_title', { n })}
            closeLabel={t('extract.fs_close')}
            register={observe}
            onToggle={(pageNumber) => toggle(pageNumber)}
          />
        </>
      ) : null}
    </WorkspaceShell>
  );
}

// token-mapped
