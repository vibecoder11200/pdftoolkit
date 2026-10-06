import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { takePendingFiles } from '../../lib/handoff';
import { useThumbnails } from '../../hooks/use-thumbnails';
import { engine } from '../../engine/client';
import { downloadBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { parseRanges } from '../../lib/ranges';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { FileIcon, XIcon } from '../ui/icons';
import { ThumbnailStrip } from './thumbnail-strip';

type SplitMode = 'combined' | 'separate';

function compactRanges(pages: number[]): string {
  const sorted = Array.from(new Set(pages))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  const parts: string[] = [];
  let start = 0;
  let prev = 0;
  for (const n of sorted) {
    if (start === 0) {
      start = n;
      prev = n;
      continue;
    }
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  if (start !== 0) parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(',');
}

function baseName(fileName: string): string {
  const stripped = fileName.replace(/\.pdf$/i, '');
  return stripped.trim() === '' ? 'split' : stripped;
}

function splitErrorKey(error: string): { key: string; part?: string; page?: string } {
  if (error === 'empty') return { key: 'split.err_empty' };
  const idx = error.indexOf(':');
  const kind = idx === -1 ? error : error.slice(0, idx);
  const detail = idx === -1 ? '' : error.slice(idx + 1);
  if (kind === 'overlap') return { key: 'split.err_overlap', page: detail };
  if (kind === 'range') return { key: 'split.err_range', part: detail };
  return { key: 'split.err_bad', part: detail };
}

export function SplitTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, removeAt, clear } = useDropFiles();
  // Home-sheet handoff (one-shot take; StrictMode's double effect adds nothing).
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);

  const [numPages, setNumPages] = useState(0);
  const [rangesText, setRangesText] = useState('');
  const [mode, setMode] = useState<SplitMode>('separate');
  const [lastValid, setLastValid] = useState<number[]>([]);
  const [loadSeq, setLoadSeq] = useState(0);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const genRef = useRef(0);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';

  const file = files[0] ?? null;

  useEffect(() => {
    const gen = (genRef.current += 1);
    setLoadSeq((n) => n + 1);
    setNumPages(0);
    setLastValid([]);
    if (!file) return;
    void engine
      .loadPdf(file.bytes)
      .then(({ info }) => {
        if (genRef.current !== gen) return;
        setNumPages(info.numPages);
      })
      .catch(() => {
        if (genRef.current !== gen) return;
        setNumPages(0);
      });
  }, [file]);

  const parsed = numPages > 0 ? parseRanges(rangesText, numPages) : parseRanges('', 1);

  useEffect(() => {
    if (!parsed.error && parsed.ranges.length > 0) setLastValid(parsed.ranges.flat());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangesText, numPages]);

  const covered = parsed.error ? lastValid : parsed.ranges.flat();
  const coveredSet = new Set(covered);

  const thumbJobs =
    file && numPages > 0
      ? Array.from({ length: numPages }, (_, i) => ({
          id: `p${i + 1}`,
          bytes: file.bytes,
          page: i + 1,
          version: loadSeq,
        }))
      : [];
  const { urlFor, observe } = useThumbnails(thumbJobs);

  const liveError = (() => {
    if (!file || numPages === 0) return null;
    if (rangesText.trim() === '') return null;
    if (!parsed.error) return null;
    const { key, part, page } = splitErrorKey(parsed.error);
    return t(key, { part, page, max: numPages });
  })();

  const togglePage = (pageNumber: number) => {
    const current = new Set(lastValid);
    if (current.has(pageNumber)) current.delete(pageNumber);
    else current.add(pageNumber);
    setRangesText(compactRanges([...current]));
    setRunError(null);
  };

  const run = async () => {
    setRunError(null);
    if (!file) {
      setRunError(t('split.no_file'));
      return;
    }
    if (numPages === 0) {
      setRunError(t('split.err_unreadable'));
      return;
    }
    const parsedNow = parseRanges(rangesText, numPages);
    if (parsedNow.error || parsedNow.ranges.length === 0) {
      const { key, part, page } = splitErrorKey(parsedNow.error ?? 'empty');
      setRunError(t(key, { part, page, max: numPages }));
      return;
    }
    setBusy(true);
    try {
      const stem = baseName(file.file.name);
      if (mode === 'combined') {
        const combined = parsedNow.ranges.flat();
        setProgress({ value: 20, label: t('split.progress_working', { count: combined.length }) });
        const outs = await engine.splitRanges(file.bytes, [combined]);
        setProgress({ value: 100, label: t('split.progress_done') });
        if (outs[0]) downloadBytes(outs[0], `${stem}-split.pdf`);
      } else {
        setProgress({
          value: 20,
          label: t('split.progress_working_many', { count: parsedNow.ranges.length }),
        });
        const outs = await engine.splitRanges(file.bytes, parsedNow.ranges);
        setProgress({ value: 100, label: t('split.progress_done') });
        outs.forEach((out, i) => downloadBytes(out, `${stem}-part${i + 1}.pdf`));
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <WorkspaceShell
      title={t('split.title')}
      meta={
        file
          ? t('meta.file_pages', {
                name: file.file.name,
                count: numPages,
                size: formatBytes(file.file.size, lng === 'vi' ? 'vi-VN' : 'en-US'),
              })
          : undefined
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: file ? 'done' : 'now' },
        { key: 'configure', label: t('steps.configure'), state: covered.length > 0 ? 'done' : file ? 'now' : 'todo' },
        { key: 'download', label: t('steps.download'), state: progress?.value === 100 ? 'done' : 'todo' },
      ]}
      error={fileError ?? runError}
      side={
        <>
          <label className="flex flex-col gap-1.5 text-[13.5px]">
            <span className="font-semibold text-text-primary">{t('split.ranges_label')}</span>
            <textarea
              value={rangesText}
              onChange={(e) => {
                setRangesText(e.target.value);
                setRunError(null);
              }}
              placeholder={t('split.ranges_placeholder')}
              rows={3}
              inputMode="numeric"
              aria-label={t('split.ranges_label')}
              className="min-h-11 w-full rounded-lg border border-border-strong bg-surface-card px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </label>
          {liveError ? (
            <p role="alert" className="text-[13px] text-danger">
              {liveError}
            </p>
          ) : (
            <p className="text-[13px] text-text-muted">{t('split.ranges_hint', { max: numPages })}</p>
          )}
          <p className="text-[13px] font-semibold text-text-primary tabular-nums">
            {t('split.covered_count', { count: covered.length })}
          </p>
          <div role="radiogroup" aria-label={t('split.mode_label')} className="flex flex-col gap-2">
            <span className="text-[13.5px] font-semibold text-text-primary">{t('split.mode_label')}</span>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'separate'}
              onClick={() => setMode('separate')}
              className={`min-h-11 rounded-lg border px-4 py-2 text-left text-sm font-semibold ${
                mode === 'separate'
                  ? 'border-accent bg-accent-soft text-text-primary'
                  : 'border-border-strong bg-surface-card text-text-muted'
              }`}
            >
              {t('split.mode_separate')}
            </button>
            <p className="-mt-1 text-xs text-text-muted">{t('split.mode_separate_hint')}</p>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'combined'}
              onClick={() => setMode('combined')}
              className={`min-h-11 rounded-lg border px-4 py-2 text-left text-sm font-semibold ${
                mode === 'combined'
                  ? 'border-accent bg-accent-soft text-text-primary'
                  : 'border-border-strong bg-surface-card text-text-muted'
              }`}
            >
              {t('split.mode_combined')}
            </button>
            <p className="-mt-1 text-xs text-text-muted">{t('split.mode_combined_hint')}</p>
          </div>
          <Button onClick={() => void run()} disabled={!file || busy}>
            {t('split.cta')}
          </Button>
          {progress ? null : (
            <span className="text-[13px] text-text-muted">{t('split.progress_idle')}</span>
          )}
        </>
      }
      progress={progress}
      onReset={() => {
        clear();
        setRangesText('');
        setMode('separate');
        setLastValid([]);
        setProgress(null);
        setRunError(null);
      }}
    >
      <Dropzone
        title={t('split.dropzone_title')}
        hint={t('split.dropzone_hint')}
        accept="application/pdf,.pdf"
        multiple={false}
        onFiles={(f) => {
          clear();
          void add(f.slice(0, 1));
        }}
      />
      {file ? (
        <div className="mt-3 flex flex-col gap-2">
          <div
            key={`${file.file.name}-0`}
            className="flex items-center gap-2.5 rounded-lg border border-border-default p-2.5 text-[13.5px]"
          >
            <span className="text-text-muted"><FileIcon size={17} /></span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{file.file.name}</span>
            <span className="ml-auto text-xs whitespace-nowrap text-text-muted tabular-nums">
              {formatBytes(file.file.size, lng === 'vi' ? 'vi-VN' : 'en-US')} · {t('units.pages', { count: numPages })}
            </span>
            <button
              type="button"
              aria-label={`Remove ${file.file.name}`}
              className="min-h-10 min-w-10 text-text-muted hover:text-danger"
              onClick={() => removeAt(0)}
            >
              <XIcon />
            </button>
          </div>
        </div>
      ) : null}
      {numPages > 0 ? (
        <>
          <div className="mt-3.5 mb-2.5 flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
            <span className="font-bold text-text-primary">
              {t('split.covered_count', { count: covered.length })}
            </span>
            <span>· {t('split.thumb_hint')}</span>
          </div>
          <ThumbnailStrip
            pages={Array.from({ length: numPages }, (_, i) => ({
              key: `p${i + 1}`,
              pageNumber: i + 1,
              url: urlFor(`p${i + 1}`),
              selected: coveredSet.has(i + 1),
            }))}
            fullscreenTitle={(n) => t('split.fs_title', { n })}
            closeLabel={t('split.fs_close')}
            register={observe}
            onToggle={(pageNumber: number) => togglePage(pageNumber)}
          />
        </>
      ) : null}
    </WorkspaceShell>
  );
}

// token-mapped
