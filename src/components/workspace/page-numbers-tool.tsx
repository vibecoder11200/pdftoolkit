import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useDropFiles } from '../../hooks/use-drop-files';
import { takePendingFiles, appendPendingFiles } from '../../lib/handoff';
import { useThumbnails } from '../../hooks/use-thumbnails';
import { engine } from '../../engine/client';
import { deliverBytes } from '../../lib/download';
import { isEncryptedError } from '../../lib/suggest';
import { renderPageTemplate } from '../../lib/page-template';
import { formatBytes } from '../../lib/format';
import type { GridPos9, PageNumbersOptions } from '../../engine/pdf-lib';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { SaveElsewhereButton } from '../ui/save-elsewhere-button';
import { WorkspaceShell } from './workspace-shell';
import { ContinueChip } from './continue-chip';
import { useLastOutput } from '../../hooks/use-last-output';
import { ThumbnailStrip } from './thumbnail-strip';
import { PositionGrid } from './position-grid';
import { FileIcon } from '../ui/icons';

/*
 * Page numbers tool (v0.8.0 phase 3): a 1-click preset row (each preset is a
 * fixed options object) plus an advanced tab (token template + live preview
 * via the PURE renderPageTemplate — no worker roundtrip, no engine import;
 * finding 7). Single-file tool (no folder batch — settled scope). The run
 * itself always goes through the worker: engine.applyPageNumbers.
 */

const TOKENS = ['{n}', '{total}', '{date}', '{filename}'] as const;

function outputName(original: string): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'numbered';
  return `${base}-numbered.pdf`;
}

interface ToolState {
  template: string;
  position: GridPos9;
  margin: number;
  fontSize: number;
  startNumber: number;
}

const BASE_STATE: ToolState = {
  template: '{n}',
  position: 'bottom-center',
  margin: 36,
  fontSize: 12,
  startNumber: 1,
};

export function PageNumbersTool() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { files, error: fileError, add, clear } = useDropFiles();
  const { lastOutput, keep } = useLastOutput();
  // Home-sheet handoff (one-shot take; StrictMode's double effect adds nothing).
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);

  const source = files[0] ?? null;
  const [numPages, setNumPages] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [encrypted, setEncrypted] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [state, setState] = useState<ToolState>(BASE_STATE);
  const [preset, setPreset] = useState<0 | 1 | 2 | 3>(0);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const genRef = useRef(0);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';
  const locale = lng === 'vi' ? 'vi-VN' : 'en-US';

  // Scope seeding is keyed on [source, preset]: a file change rebuilds the
  // scope (finding 13 — stale selections never reach the engine; the engine
  // clamp is the backstop only), and the skip-first preset re-seeds to 2..N.
  useEffect(() => {
    const gen = (genRef.current += 1);
    setEncrypted(false);
    setLoadError(null);
    setNumPages(0);
    setSelected(new Set());
    if (!source) return;
    let cancelled = false;
    void (async () => {
      try {
        const { info } = await engine.loadPdf(source.bytes);
        if (cancelled || genRef.current !== gen) return;
        setNumPages(info.numPages);
        setSelected(allPages(info.numPages, preset === 3));
      } catch (e) {
        if (cancelled || genRef.current !== gen) return;
        setNumPages(0);
        setSelected(new Set());
        if (isEncryptedError(e)) setEncrypted(true);
        else setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, preset]);

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

  const toggle = useCallback((page: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  }, []);

  function allPages(n: number, skipFirst: boolean): Set<number> {
    const all = new Set<number>();
    for (let p = skipFirst ? 2 : 1; p <= n; p += 1) all.add(p);
    return all;
  }

  // Preset click = configure + run-ready: the [source, preset] effect
  // re-seeds the scope (all pages; skip-first → 2..N); the user still
  // presses the deliver button, consistent with every other tool.
  const applyPreset = (idx: 0 | 1 | 2 | 3) => {
    setPreset(idx);
    setShowAdvanced(false);
    const next: ToolState =
      idx === 0
        ? { ...BASE_STATE }
        : idx === 1
          ? { ...BASE_STATE, template: '{n}/{total}' }
          : idx === 2
            ? { ...BASE_STATE, template: t('page-numbers.preset3_template') }
            : { ...BASE_STATE, template: '{n}/{total}' };
    setState(next);
  };

  const openAdvanced = () => {
    setShowAdvanced(true);
  };

  const buildOpts = (): PageNumbersOptions => ({
    template: state.template.trim() || '{n}',
    position: state.position,
    margin: state.margin,
    fontSize: state.fontSize,
    startNumber: Math.max(0, state.startNumber),
    pages: [...selected].sort((a, b) => a - b),
    filename: source?.file.name ?? '',
  });

  const run = async (dest: 'download' | 'pick' = 'download') => {
    setRunError(null);
    if (!source) {
      setRunError(t('page-numbers.err_no_file'));
      return;
    }
    if (selected.size === 0) {
      setRunError(t('page-numbers.err_no_selection'));
      return;
    }
    try {
      setProgress({ value: 20, label: t('page-numbers.progress_working') });
      const out = await engine.applyPageNumbers(source.bytes, buildOpts());
      if (await deliverBytes(out, outputName(source.file.name), dest)) {
        keep(out, outputName(source.file.name));
        setProgress({ value: 100, label: t('page-numbers.progress_done') });
      } else {
        setProgress(null); // picker cancelled — not an error
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRunError(t('page-numbers.err_failed', { message }));
      setProgress(null);
    }
  };

  const parkToDecrypt = () => {
    if (!source) return;
    appendPendingFiles([source.file], { mode: 'decrypt' });
    navigate('/tools/encrypt');
  };

  const reset = () => {
    clear();
    keep(null, '');
    setNumPages(0);
    setSelected(new Set());
    setEncrypted(false);
    setLoadError(null);
    setProgress(null);
    setRunError(null);
  };

  const busy = progress !== null && progress.value < 100;

  // Live preview (pages 1–3) — PURE string rendering, no worker roundtrip.
  const previewLines = [1, 2, 3].map((p) => ({
    page: p,
    text: selected.has(p)
      ? renderPageTemplate(state.template.trim() || '{n}', {
          n: p + (Math.max(0, state.startNumber) - 1),
          total: numPages,
          filename: source?.file.name ?? t('page-numbers.preview_no_file'),
        })
      : null,
  }));

  const presetLabels = [
    t('page-numbers.preset1'),
    t('page-numbers.preset2'),
    t('page-numbers.preset3'),
    t('page-numbers.preset4'),
  ];

  return (
    <WorkspaceShell
      title={t('page-numbers.title')}
      meta={
        source
          ? t('meta.file_pages', {
              name: source.file.name,
              count: numPages,
              size: formatBytes(source.file.size, locale),
            })
          : undefined
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: source ? 'done' : 'now' },
        { key: 'configure', label: t('steps.configure'), state: source ? 'now' : 'todo' },
        { key: 'download', label: t('steps.download'), state: 'todo' },
      ]}
      error={fileError ?? runError ?? loadError}
      side={
        <>
          {encrypted ? (
            <div className="flex flex-col gap-2">
              <p className="text-[13.5px] text-text-primary">{t('page-numbers.err_encrypted')}</p>
              <Button onClick={parkToDecrypt}>{t('page-numbers.decrypt_cta')}</Button>
            </div>
          ) : (
            <>
              <fieldset>
                <legend className="text-sm font-bold">{t('page-numbers.preset_q')}</legend>
                <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label={t('page-numbers.preset_q')}>
                  {presetLabels.map((label, idx) => (
                    <label
                      key={idx}
                      className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
                        preset === idx && !showAdvanced
                          ? 'border-accent bg-surface-card'
                          : 'border-border-strong bg-surface-card'
                      }`}
                    >
                      <input
                        type="radio"
                        name="pagenums-preset"
                        checked={preset === idx && !showAdvanced}
                        onChange={() => applyPreset(idx as 0 | 1 | 2 | 3)}
                        className="h-4 w-4 accent-accent"
                      />
                      <span className="font-semibold">{label}</span>
                    </label>
                  ))}
                  <label
                    className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
                      showAdvanced ? 'border-accent bg-surface-card' : 'border-border-strong bg-surface-card'
                    }`}
                  >
                    <input
                      type="radio"
                      name="pagenums-preset"
                      checked={showAdvanced}
                      onChange={openAdvanced}
                      className="h-4 w-4 accent-accent"
                    />
                    <span className="font-semibold">{t('page-numbers.preset_advanced')}</span>
                  </label>
                </div>
              </fieldset>

              {showAdvanced ? (
                <>
                  <fieldset>
                    <legend className="text-sm font-bold">{t('page-numbers.template_label')}</legend>
                    <input
                      type="text"
                      value={state.template}
                      onChange={(e) => setState((s) => ({ ...s, template: e.target.value }))}
                      className="mt-2 w-full rounded-lg border border-border-strong bg-surface-card px-3 py-2 text-sm"
                      aria-label={t('page-numbers.template_label')}
                    />
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {TOKENS.map((tok) => (
                        <button
                          key={tok}
                          type="button"
                          onClick={() => setState((s) => ({ ...s, template: s.template + tok }))}
                          className="min-h-8 rounded-lg border border-border-strong bg-surface-card px-2 text-[12.5px] font-semibold tabular-nums"
                        >
                          {tok}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 rounded-lg border border-border-default bg-surface-page px-3 py-2 text-[13px]">
                      <span className="block text-[12px] font-bold text-text-muted">
                        {t('page-numbers.preview_heading')}
                      </span>
                      {previewLines.map((line) => (
                        <span key={line.page} className="mt-0.5 block tabular-nums">
                          <span className="text-text-muted">{line.page}:</span>{' '}
                          {line.text ?? t('page-numbers.preview_excluded')}
                        </span>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="text-sm font-bold">{t('page-numbers.position')}</legend>
                    <PositionGrid
                      value={state.position}
                      onChange={(position) => setState((s) => ({ ...s, position }))}
                      label={t('page-numbers.position')}
                    />
                    <label className="mt-2 block text-[13px] font-semibold">
                      {t('page-numbers.margin', { value: state.margin })}
                      <input
                        type="range"
                        min={12}
                        max={72}
                        value={state.margin}
                        onChange={(e) => setState((s) => ({ ...s, margin: Number(e.target.value) }))}
                        className="mt-1 w-full accent-accent"
                      />
                    </label>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <label className="block text-[13px] font-semibold">
                        {t('page-numbers.font_size')}
                        <input
                          type="number"
                          min={8}
                          max={24}
                          value={state.fontSize}
                          onChange={(e) =>
                            setState((s) => ({
                              ...s,
                              fontSize: Math.max(8, Math.min(24, Number(e.target.value) || 12)),
                            }))
                          }
                          className="mt-1 w-full rounded-lg border border-border-strong bg-surface-card px-2 py-1.5 text-[13px] tabular-nums"
                        />
                      </label>
                      <label className="block text-[13px] font-semibold">
                        {t('page-numbers.start_number')}
                        <input
                          type="number"
                          min={0}
                          value={state.startNumber}
                          onChange={(e) =>
                            setState((s) => ({ ...s, startNumber: Number(e.target.value) || 0 }))
                          }
                          className="mt-1 w-full rounded-lg border border-border-strong bg-surface-card px-2 py-1.5 text-[13px] tabular-nums"
                        />
                      </label>
                    </div>
                  </fieldset>
                </>
              ) : null}

              <Button onClick={() => void run()} disabled={!source || selected.size === 0 || busy}>
                {t('page-numbers.cta')}
              </Button>
              <SaveElsewhereButton
                disabled={!source || selected.size === 0 || busy}
                onClick={() => void run('pick')}
              />
          {lastOutput ? (
            <ContinueChip bytes={lastOutput.bytes} filename={lastOutput.filename} />
          ) : null}
              {progress ? null : (
                <span className="text-[13px] text-text-muted">{t('page-numbers.progress_idle')}</span>
              )}
            </>
          )}
        </>
      }
      progress={progress}
      onReset={reset}
      onReselectAll={() => setSelected(allPages(numPages, false))}
    >
      <Dropzone
        title={t('page-numbers.dropzone_title')}
        hint={t('page-numbers.dropzone_hint')}
        accept="application/pdf,.pdf"
        multiple={false}
        onFiles={(f) => {
          clear();
          void add(f.slice(0, 1));
        }}
      />
      {source ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-border-default p-2.5 text-[13.5px]">
          <span className="text-text-muted"><FileIcon size={17} /></span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{source.file.name}</span>
          <span className="ml-auto text-xs whitespace-nowrap text-text-muted tabular-nums">
            {formatBytes(source.file.size, locale)} · {t('units.pages', { count: numPages })}
          </span>
        </div>
      ) : null}
      {numPages > 0 ? (
        <>
          <div className="mt-3.5 mb-2.5 flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
            <span className="font-bold text-text-primary">
              {t('page-numbers.selected_count', { count: selected.size, total: numPages })}
            </span>
            <span>· {t('page-numbers.thumb_hint')}</span>
          </div>
          <ThumbnailStrip
            pages={Array.from({ length: numPages }, (_, i) => i + 1).map((p) => ({
              key: `p${p}`,
              pageNumber: p,
              url: urlFor(`p${p}`),
              selected: selected.has(p),
            }))}
            fullscreenTitle={(n) => t('a11y.page_n', { n })}
            closeLabel={t('home.sheet_close')}
            register={observe}
            onToggle={(pageNumber: number) => toggle(pageNumber)}
          />
        </>
      ) : null}
    </WorkspaceShell>
  );
}

// token-mapped
