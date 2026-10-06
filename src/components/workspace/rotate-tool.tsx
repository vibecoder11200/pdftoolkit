import { useCallback, useEffect, useRef, useState } from 'react';
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

type Angle = 90 | 180 | 270;

const ANGLES: Angle[] = [90, 180, 270];

export function RotateTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  // Home-sheet handoff (one-shot take; StrictMode's double effect adds nothing).
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);

  const source = files[0] ?? null;
  const [numPages, setNumPages] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [angle, setAngle] = useState<Angle>(90);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const genRef = useRef(0);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';

  const reselectAll = useCallback(() => {
    setNumPages((n) => {
      if (n > 0) {
        const all = new Set<number>();
        for (let p = 1; p <= n; p += 1) all.add(p);
        queueMicrotask(() => setSelected(all));
      }
      return n;
    });
  }, []);

  useEffect(() => {
    const gen = (genRef.current += 1);
    if (!source) {
      setNumPages(0);
      setSelected(new Set());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { info } = await engine.loadPdf(source.bytes);
        if (cancelled || genRef.current !== gen) return;
        setNumPages(info.numPages);
        const all = new Set<number>();
        for (let p = 1; p <= info.numPages; p += 1) all.add(p);
        setSelected(all);
        setRunError(null);
      } catch (e) {
        if (cancelled || genRef.current !== gen) return;
        setNumPages(0);
        setSelected(new Set());
        setRunError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Keyed by page number; the preview pre-rotates via CSS, so the bytes and
  // therefore the rendered thumbnail never change while picking an angle.
  const thumbJobs =
    source && numPages > 0
      ? Array.from({ length: numPages }, (_, i) => ({
          id: `p${i + 1}`,
          bytes: source.bytes,
          page: i + 1,
          version: genRef.current,
        }))
      : [];
  const { urlFor, observe } = useThumbnails(thumbJobs);

  const toggle = (page: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  };

  const run = async () => {
    setRunError(null);
    if (!source) {
      setRunError(t('rotate.err_no_file'));
      return;
    }
    const targets = [...selected].sort((a, b) => a - b);
    if (targets.length === 0) {
      setRunError(t('rotate.err_no_selection'));
      return;
    }
    try {
      setProgress({ value: 20, label: t('rotate.progress_working', { count: targets.length }) });
      const out = await engine.rotatePages(source.bytes, targets, angle);
      setProgress({ value: 100, label: t('rotate.progress_done') });
      downloadBytes(out, 'rotated.pdf');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRunError(t('rotate.err_failed', { message }));
      setProgress(null);
    }
  };

  const reset = () => {
    clear();
    setNumPages(0);
    setSelected(new Set());
    setProgress(null);
    setRunError(null);
  };

  return (
    <WorkspaceShell
      title={t('rotate.title')}
      meta={
        source
          ? t('meta.file_pages', {
                name: source.file.name,
                count: numPages,
                size: formatBytes(source.file.size, lng === 'vi' ? 'vi-VN' : 'en-US'),
              })
          : undefined
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: source ? 'done' : 'now' },
        { key: 'configure', label: t('steps.configure'), state: source ? 'now' : 'todo' },
        { key: 'download', label: t('steps.download'), state: 'todo' },
      ]}
      error={fileError ?? runError}
      side={
        <>
          <fieldset>
            <legend className="text-sm font-bold">{t('rotate.angle_q')}</legend>
            <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label={t('rotate.angle_q')}>
              {ANGLES.map((deg) => (
                <label
                  key={deg}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
                    angle === deg ? 'border-accent bg-surface-card' : 'border-border-strong bg-surface-card'
                  }`}
                >
                  <input
                    type="radio"
                    name="rotate-angle"
                    value={deg}
                    checked={angle === deg}
                    onChange={() => setAngle(deg)}
                    className="h-4 w-4 accent-accent"
                  />
                  <span className="font-semibold tabular-nums">{deg}°</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Button onClick={() => void run()} disabled={!source || selected.size === 0}>
            {t('rotate.cta')}
          </Button>
          {progress ? null : (
            <span className="text-[13px] text-text-muted">{t('rotate.progress_idle')}</span>
          )}
          {numPages > 0 ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={reselectAll}
                className="min-h-9 rounded-lg border border-border-strong bg-surface-card px-3.5 text-[13px] font-semibold"
              >
                {t('rotate.select_all')}
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="min-h-9 rounded-lg border border-border-strong bg-surface-card px-3.5 text-[13px]"
              >
                {t('rotate.clear_selection')}
              </button>
            </div>
          ) : null}
        </>
      }
      progress={progress}
      onReset={reset}
      onReselectAll={reselectAll}
    >
      <Dropzone
        title={t('rotate.dropzone_title')}
        hint={t('rotate.dropzone_hint')}
        accept="application/pdf,.pdf"
        multiple={false}
        onFiles={(f) => {
          clear();
          void add(f.slice(0, 1));
        }}
      />
      {numPages > 0 ? (
        <>
          <div className="mt-3.5 mb-2.5 flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
            <span className="font-bold text-text-primary">
              {t('rotate.selected_count', { count: selected.size, total: numPages })}
            </span>
            <span>· {t('rotate.thumb_hint')}</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => {
              const isSelected = selected.has(p);
              return (
                <div
                  key={p}
                  ref={(el) => observe(`p${p}`, el)}
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-label={t('a11y.page_n', { n: p })}
                  tabIndex={0}
                  onClick={() => toggle(p)}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      toggle(p);
                    }
                  }}
                  className={`relative cursor-pointer rounded-lg border-2 bg-surface-card p-1.5 ${
                    isSelected ? 'border-accent' : 'border-border-default hover:border-border-strong'
                  }`}
                >
                  <span className="absolute top-2.5 left-2.5 z-10 rounded-md bg-surface-inverse/85 px-1.75 py-0.5 text-[11px] font-bold text-text-inverse tabular-nums">
                    {p}
                  </span>
                  <span
                    className={`absolute top-2 right-2 z-10 grid h-6 w-6 place-items-center rounded-full border-2 text-[13px] ${
                      isSelected
                        ? 'border-accent bg-accent text-text-on-accent'
                        : 'border-border-strong bg-surface-card text-transparent'
                    }`}
                    aria-hidden
                  >
                    ✓
                  </span>
                  {isSelected ? (
                    <span className="absolute bottom-2.5 left-2.5 z-10 rounded-md bg-accent px-1.75 py-0.5 text-[11px] font-bold text-text-on-accent tabular-nums">
                      {angle}°
                    </span>
                  ) : null}
                  {urlFor(`p${p}`) ? (
                    <img
                      src={urlFor(`p${p}`) ?? undefined}
                      alt=""
                      draggable={false}
                      className="block aspect-[0.707] w-full rounded border border-border-default object-contain transition-transform duration-200"
                      style={isSelected ? { transform: `rotate(${angle}deg)` } : undefined}
                    />
                  ) : (
                    <span
                      className="block aspect-[0.707] w-full rounded border border-border-default bg-gradient-to-b from-surface-card to-surface-sunken transition-transform duration-200"
                      style={isSelected ? { transform: `rotate(${angle}deg)` } : undefined}
                      aria-hidden
                    />
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </WorkspaceShell>
  );
}

// token-mapped
