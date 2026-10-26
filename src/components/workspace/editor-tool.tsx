import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useDropFiles } from '../../hooks/use-drop-files';
import { takePendingFiles, appendPendingFiles } from '../../lib/handoff';
import { useThumbnails } from '../../hooks/use-thumbnails';
import { engine } from '../../engine/client';
import { deliverBytes } from '../../lib/download';
import { isEncryptedError } from '../../lib/suggest';
import { engineErrorDetail } from '../../lib/engine-error';
import { formatBytes } from '../../lib/format';
import {
  REDACT_RASTER_BUDGET,
  parseSecrets,
  runRedactionPipeline,
  type RedactCensusKind,
  type RedactCensusReport,
  type RedactMark,
  type RedactPhase,
} from '../../lib/redact-pipeline';
import { Dropzone } from '../ui/dropzone';
import { type ErrorDetail } from '../ui/error-banner';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { ContinueChip } from './continue-chip';
import { useLastOutput } from '../../hooks/use-last-output';
import { ThumbnailStrip } from './thumbnail-strip';
import { EditorCanvas, newMarkId } from './editor-canvas';
import { AnnotateCanvasArea, AnnotateControls, useAnnotateState } from './annotate-tab';
import { EditTextArea, EditTextControls, useEditTextState } from './edit-text-tab';
import { FileIcon } from '../ui/icons';

/*
 * Editor tool (v0.9.0 phase 3) — tool #17 'Sửa PDF', four-tab shell of which
 * THIS phase ships the redact tab (annotate/edit/crop mount in phases 4–7).
 * The tab NEVER composes engine primitives: every run goes through
 * src/lib/redact-pipeline.ts (census → raster JPEGs painted pre-encode →
 * redactFinalize → semantic + pixel legs) and only pipeline output reaches
 * deliverBytes — the orphan rule is structural, not conventional.
 *
 * Race guards (twice-pinned split-tool class): the load+census probe rides a
 * generation ref + probeRef (an early Apply awaits it instead of misreading
 * a healthy file); marks/burn/keep/scrub state resets on file identity
 * change; Apply is disabled while the probe is pending.
 *
 * Phone width (D3): the editing surfaces are desktop/tablet-only with honest
 * copy; pinch-zoom is a recorded follow-up.
 */

type Tab = 'redact' | 'annotate' | 'edit' | 'crop';
type RedactMode = 'surgical' | 'raster';

const KIND_KEYS: Record<RedactCensusKind, string> = {
  type3: 'redact.kind_type3',
  'font-no-tounicode': 'redact.kind_font_no_tounicode',
  actualtext: 'redact.kind_actualtext',
  tr3: 'redact.kind_tr3',
  'pattern-text': 'redact.kind_pattern_text',
  'xobject-text': 'redact.kind_xobject_text',
  'vertical-text': 'redact.kind_vertical_text',
  'oc-props': 'redact.kind_oc_props',
  widget: 'redact.kind_widget',
  'annot-text': 'redact.kind_annot_text',
  'annot-hidden': 'redact.kind_annot_hidden',
  'annot-ap-text': 'redact.kind_annot_ap_text',
  'stream-undecodable': 'redact.kind_stream_undecodable',
};

const EMPTY_BYTES = new Uint8Array();

function redactedName(original: string): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'document';
  return `${base}-redacted.pdf`;
}

export function EditorTool() {
  // Bare t() keys MUST resolve in common.json (the v0.8.1 raw-key incident);
  // declaring 'tools' here is for the ContinueChip picker titles only.
  const { t, i18n } = useTranslation(['common', 'tools']);
  const navigate = useNavigate();
  const { files, error: fileError, add, clear } = useDropFiles();
  const { lastOutput, keep } = useLastOutput();
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);

  const source = files[0] ?? null;
  const [numPages, setNumPages] = useState(0);
  const [encrypted, setEncrypted] = useState(false);
  const [censusError, setCensusError] = useState<string | null>(null);
  const [census, setCensus] = useState<RedactCensusReport | null>(null);
  const [tab, setTab] = useState<Tab>('redact');
  const [currentPage, setCurrentPage] = useState(1);
  const [marks, setMarks] = useState<RedactMark[]>([]);
  const [mode, setMode] = useState<RedactMode>('surgical');
  const [secretsText, setSecretsText] = useState('');
  const [burnPages, setBurnPages] = useState<Set<number>>(new Set());
  const [keptFlagged, setKeptFlagged] = useState<Set<number>>(new Set());
  const [scrubSkip, setScrubSkip] = useState<Set<string>>(new Set());
  const [probePending, setProbePending] = useState(false);
  const [rasterConfirm, setRasterConfirm] = useState(false);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<string | ErrorDetail | null>(null);
  const [
    report,
    setReport,
  ] = useState<{
    surgical: number[];
    raster: number[];
    escalated: number[];
    removedBlocks: number;
    scrub: { channel: string; sample: string }[];
  } | null>(null);
  const genRef = useRef(0);
  // In-flight load+census probe: an early Apply awaits it (split-tool
  // pattern) instead of misreporting a healthy file.
  const probeRef = useRef<Promise<void> | null>(null);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';
  const locale = lng === 'vi' ? 'vi-VN' : 'en-US';

  // File identity change: EVERYTHING from the previous file dies here.
  useEffect(() => {
    const gen = (genRef.current += 1);
    setEncrypted(false);
    setCensusError(null);
    setCensus(null);
    setNumPages(0);
    setCurrentPage(1);
    setMarks([]);
    setBurnPages(new Set());
    setKeptFlagged(new Set());
    setScrubSkip(new Set());
    setRasterConfirm(false);
    setRunError(null);
    setReport(null);
    setProbePending(Boolean(source));
    probeRef.current = null;
    if (!source) return;
    const probe = (async () => {
      try {
        const { info } = await engine.loadPdf(source.bytes);
        if (genRef.current !== gen) return;
        setNumPages(info.numPages);
        const report = await engine.redactCensus(source.bytes);
        if (genRef.current !== gen) return;
        // Census-flagged pages default to BURN (safety-first tier rule) —
        // the user can keep a page explicitly.
        setBurnPages(new Set(report.pages.map((p) => p.page)));
        setCensus(report);
      } catch (e) {
        if (genRef.current !== gen) return;
        if (isEncryptedError(e)) setEncrypted(true);
        else setCensusError(t('editor.err_unreadable'));
      } finally {
        // Only the owning generation may clear the slot — a stale probe must
        // not clobber a newer file's in-flight probe.
        if (genRef.current === gen) {
          probeRef.current = null;
          setProbePending(false);
        }
      }
    })();
    probeRef.current = probe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

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

  const annotate = useAnnotateState(
    source?.bytes ?? EMPTY_BYTES,
    source?.file.name ?? '',
    currentPage,
  );
  const editText = useEditTextState(
    source?.bytes ?? EMPTY_BYTES,
    source?.file.name ?? '',
    currentPage,
  );
  // Visual size of the current page — scales the annotate preview to the render.
  const [pageVisual, setPageVisual] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!source || numPages <= 0) {
      setPageVisual(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { getPageVisualSize } = await import('../../engine/pdfjs');
        const size = await getPageVisualSize(source.bytes, currentPage);
        if (!cancelled) setPageVisual(size);
      } catch {
        /* preview scale falls back to 0 (text shown unscaled) */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, currentPage, numPages]);

  const pageMarks = marks.filter((m) => m.page === currentPage);
  const flagged = census?.pages ?? [];

  const addMark = (m: Omit<RedactMark, 'id' | 'page'>) => {
    setMarks((prev) => [...prev, { id: newMarkId(), page: currentPage, ...m }]);
  };
  const removeMark = (id: string) => setMarks((prev) => prev.filter((m) => m.id !== id));
  const clearPageMarks = () => setMarks((prev) => prev.filter((m) => m.page !== currentPage));

  const chooseKeep = (page: number) => {
    setBurnPages((prev) => {
      const next = new Set(prev);
      next.delete(page);
      return next;
    });
    setKeptFlagged((prev) => {
      const next = new Set(prev);
      next.add(page);
      return next;
    });
  };

  const chooseBurn = (page: number) => {
    setKeptFlagged((prev) => {
      const next = new Set(prev);
      next.delete(page);
      return next;
    });
    setBurnPages((prev) => {
      const next = new Set(prev);
      next.add(page);
      return next;
    });
  };

  const toggleScrubSkip = (channel: string) => {
    setScrubSkip((prev) => {
      const next = new Set(prev);
      if (next.has(channel)) next.delete(channel);
      else next.add(channel);
      return next;
    });
  };

  const phaseLabel = (phase: RedactPhase, done: number, total: number) =>
    phase === 'render'
      ? t('redact.progress_render', { done: done + 1, total })
      : phase === 'finalize'
        ? t('redact.progress_finalize')
        : t('redact.progress_verify');

  const runRedact = async (dest: 'download' | 'pick' = 'download', confirmed = false) => {
    setRunError(null);
    setReport(null);
    setRasterConfirm(false);
    if (!source || !census) {
      setRunError(t('editor.err_unreadable'));
      return;
    }
    if (marks.length === 0 && burnPages.size === 0) {
      setRunError(t('redact.err_no_marks'));
      return;
    }
    const secrets = parseSecrets(secretsText);
    if (secrets.length === 0) {
      setRunError(t('redact.err_no_secrets'));
      return;
    }
    // Race guard (split-tool pattern): an early CTA click waits out the
    // in-flight probe; a file swap during that await means this closure's
    // inputs are stale — abort silently (the new file's effect owns the UI).
    const genAtStart = genRef.current;
    if (probeRef.current) await probeRef.current;
    if (genRef.current !== genAtStart) return;
    const input = {
      marks,
      burnPages: [...burnPages],
      keptFlagged: [...keptFlagged],
      forceRaster: mode === 'raster',
      scrubSkip: [...scrubSkip],
      secrets,
    };
    // Raster budget (finding 11): above the cap the first click only asks.
    const rasterCount = new Set([
      ...input.burnPages.filter((p) => flagged.some((f) => f.page === p)),
      ...input.marks
        .map((m) => m.page)
        .filter(
          (p) =>
            mode === 'raster' ||
            (flagged.some((f) => f.page === p) && !keptFlagged.has(p)),
        ),
    ]).size;
    if (rasterCount > REDACT_RASTER_BUDGET && !confirmed) {
      setRasterConfirm(true);
      return;
    }
    try {
      const outcome = await runRedactionPipeline(source.bytes, census, input, {
        onPhase: (phase, done, total) =>
          setProgress({ value: phase === 'verify' ? 90 : 20 + Math.round((60 * done) / Math.max(1, total)), label: phaseLabel(phase, done, total) }),
      });
      setProgress({ value: 95, label: t('redact.progress_deliver') });
      if (await deliverBytes(outcome.result.bytes, redactedName(source.file.name), dest)) {
        keep(outcome.result.bytes, redactedName(source.file.name));
        setProgress({ value: 100, label: t('redact.progress_done') });
        setReport({
          surgical: outcome.result.surgicalPages,
          raster: outcome.result.rasterPages,
          escalated: outcome.escalated,
          removedBlocks: outcome.result.removedBlocks,
          scrub: outcome.result.scrubActions.map((a) => ({ channel: a.channel, sample: a.sample })),
        });
      } else {
        setProgress(null); // picker cancelled — not an error
      }
    } catch (e) {
      setProgress(null);
      const name = e instanceof Error ? e.name : '';
      const message = e instanceof Error ? e.message : String(e);
      if (name === 'RedactRefusedError') {
        if (/signature/i.test(message)) setRunError(t('redact.err_signed'));
        else if (/partially cover/i.test(message)) setRunError(t('redact.err_partial', { pages: message }));
        else if (/census|rasterization/i.test(message)) setRunError(t('redact.err_flagged', { pages: message }));
        else setRunError(t('redact.err_refused'));
        return;
      }
      if (name === 'RedactVerifyError') {
        setRunError(t('redact.err_verify'));
        return;
      }
      if (name === 'RedactParseError') {
        setRunError(t('redact.err_parse'));
        return;
      }
      setRunError(
        engineErrorDetail(
          e,
          t('redact.err_failed', { message }),
          { title: t('redact.err_crashed'), detail: t('redact.err_crashed_detail') },
          () => void runRedact(dest, true),
        ),
      );
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
    setCurrentPage(1);
    setMarks([]);
    setEncrypted(false);
    setCensus(null);
    setCensusError(null);
    setProgress(null);
    setRunError(null);
    setReport(null);
    setRasterConfirm(false);
  };

  const busy = progress !== null && progress.value < 100;

  const redactControls = (
    <>
      <div
        className="grid grid-cols-2 gap-1 rounded-lg border border-border-strong p-1"
        role="group"
        aria-label={t('redact.mode_label')}
      >
        {(['surgical', 'raster'] as RedactMode[]).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={`min-h-9 rounded-md text-[13px] font-semibold transition ${
              mode === m ? 'bg-accent text-text-on-accent' : 'text-text-muted hover:bg-surface-hover'
            }`}
          >
            {t(m === 'surgical' ? 'redact.mode_surgical' : 'redact.mode_raster')}
          </button>
        ))}
      </div>
      <p className="text-[13px] leading-relaxed text-text-muted">
        {mode === 'surgical' ? t('redact.mode_surgical_note') : t('redact.mode_raster_note')}
      </p>

      <fieldset>
        <legend className="text-sm font-bold">{t('redact.secrets_label')}</legend>
        <textarea
          value={secretsText}
          onChange={(e) => setSecretsText(e.target.value)}
          rows={2}
          className="mt-2 w-full rounded-lg border border-border-strong bg-surface-card px-3 py-2 text-sm"
          placeholder={t('redact.secrets_placeholder')}
        />
        <p className="mt-2 text-[13px] leading-relaxed text-text-muted">{t('redact.secrets_hint')}</p>
      </fieldset>

      {flagged.length > 0 ? (
        <fieldset>
          <legend className="text-sm font-bold">{t('redact.census_title')}</legend>
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">{t('redact.census_note')}</p>
          <ul className="mt-2 flex flex-col gap-2">
            {flagged.map((f) => (
              <li key={f.page} className="rounded-lg border border-border-default p-2.5 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{t('a11y.page_n', { n: f.page })}</span>
                  <span className="flex gap-1">
                    <button
                      type="button"
                      aria-pressed={burnPages.has(f.page)}
                      onClick={() => chooseBurn(f.page)}
                      className={`min-h-8 rounded-md border px-2.5 text-[12.5px] font-semibold ${
                        burnPages.has(f.page)
                          ? 'border-accent bg-accent-soft'
                          : 'border-border-strong text-text-muted'
                      }`}
                    >
                      {t('redact.burn_page')}
                    </button>
                    <button
                      type="button"
                      aria-pressed={keptFlagged.has(f.page)}
                      onClick={() => chooseKeep(f.page)}
                      className={`min-h-8 rounded-md border px-2.5 text-[12.5px] font-semibold ${
                        keptFlagged.has(f.page)
                          ? 'border-accent bg-accent-soft'
                          : 'border-border-strong text-text-muted'
                      }`}
                    >
                      {t('redact.keep_page')}
                    </button>
                  </span>
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-muted">
                  {f.kinds.map((k) => t(KIND_KEYS[k])).join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      {census && census.docChannels.length > 0 ? (
        <fieldset>
          <legend className="text-sm font-bold">{t('redact.scrub_title')}</legend>
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">{t('redact.scrub_note')}</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {census.docChannels.map((channel) => (
              <li key={channel} className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={!scrubSkip.has(channel)}
                  onChange={() => toggleScrubSkip(channel)}
                  className="h-4 w-4 accent-accent"
                  aria-label={t('redact.scrub_channel', { channel })}
                />
                <span className="truncate font-mono text-[12.5px]">{channel}</span>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      <Button
        onClick={() => void runRedact()}
        disabled={!source || !census || busy || probePending || (marks.length === 0 && burnPages.size === 0)}
      >
        {rasterConfirm
          ? t('redact.confirm_budget', { count: REDACT_RASTER_BUDGET })
          : t('redact.confirm')}
      </Button>
      {rasterConfirm ? (
        <p className="text-[13px] leading-relaxed text-text-muted">{t('redact.budget_note')}</p>
      ) : null}
      <Button variant="secondary" onClick={() => void runRedact('pick', true)} disabled={!source || !census || busy || probePending || (marks.length === 0 && burnPages.size === 0)}>
        {t('redact.confirm_save_elsewhere')}
      </Button>
      {lastOutput ? <ContinueChip bytes={lastOutput.bytes} filename={lastOutput.filename} /> : null}
      {progress ? null : <span className="text-[13px] text-text-muted">{t('redact.progress_idle')}</span>}
    </>
  );

  const tabHost = (
    <div className="flex gap-2" role="tablist" aria-label={t('editor.title')}>
      {(['redact', 'annotate', 'edit', 'crop'] as Tab[]).map((tabKey) => (
        <button
          key={tabKey}
          type="button"
          role="tab"
          aria-selected={tab === tabKey}
          onClick={() => setTab(tabKey)}
          className={`inline-flex min-h-10 flex-1 items-center justify-center rounded-lg border px-2 text-[13px] font-semibold ${
            tab === tabKey
              ? 'border-accent bg-accent-soft text-text-primary'
              : 'border-border-strong bg-surface-card text-text-muted hover:bg-surface-hover'
          }`}
        >
          {t(
            tabKey === 'redact'
              ? 'editor.tab_redact'
              : tabKey === 'annotate'
                ? 'editor.tab_annotate'
                : tabKey === 'edit'
                  ? 'editor.tab_edit'
                  : 'editor.tab_crop',
          )}
        </button>
      ))}
    </div>
  );

  return (
    <WorkspaceShell
      title={t('editor.title')}
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
      error={fileError ?? runError ?? censusError}
      side={
        encrypted ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13.5px] text-text-primary">{t('editor.err_encrypted')}</p>
            <Button onClick={parkToDecrypt}>{t('editor.decrypt_cta')}</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="hidden md:flex md:flex-col md:gap-4">
              {tab === 'redact' ? (
                redactControls
              ) : tab === 'annotate' ? (
                <AnnotateControls state={annotate} />
              ) : tab === 'edit' ? (
                <EditTextControls state={editText} />
              ) : (
                <p className="text-[13px] text-text-muted">{t('editor.tab_placeholder')}</p>
              )}
            </div>
          </div>
        )
      }
      progress={progress}
      onReset={reset}
    >
      <Dropzone
        title={t('editor.dropzone_title')}
        hint={t('editor.dropzone_hint')}
        accept="application/pdf,.pdf"
        multiple={false}
        onFiles={(f) => {
          clear();
          void add(f.slice(0, 1));
        }}
      />
      {source ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-border-default p-2.5 text-[13.5px]">
          <span className="text-text-muted">
            <FileIcon size={17} />
          </span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{source.file.name}</span>
          <span className="ml-auto text-xs whitespace-nowrap text-text-muted tabular-nums">
            {formatBytes(source.file.size, locale)} · {t('units.pages', { count: numPages })}
          </span>
        </div>
      ) : null}

      {source && numPages > 0 ? (
        <>
          <p className="mt-4 text-[13px] text-text-muted md:hidden">{t('editor.phone_notice')}</p>
          <div className="mt-4 hidden md:block">
            {tabHost}
            {tab === 'redact' || tab === 'annotate' || tab === 'edit' ? (
              <>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    className="min-h-9 rounded-lg border border-border-strong px-3 font-semibold disabled:opacity-40"
                  >
                    ←
                  </button>
                  <span className="font-bold text-text-primary tabular-nums">
                    {t('editor.page_of', { n: currentPage, total: numPages })}
                  </span>
                  <button
                    type="button"
                    disabled={currentPage >= numPages}
                    onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
                    className="min-h-9 rounded-lg border border-border-strong px-3 font-semibold disabled:opacity-40"
                  >
                    →
                  </button>
                  {tab === 'redact' ? (
                    <>
                      <span>· {t('redact.marks_hint')}</span>
                      {pageMarks.length > 0 ? (
                        <button
                          type="button"
                          onClick={clearPageMarks}
                          className="min-h-8 rounded-lg border border-border-strong px-2.5 text-[12.5px] font-semibold"
                        >
                          {t('redact.clear_marks', { count: pageMarks.length })}
                        </button>
                      ) : null}
                    </>
                  ) : tab === 'annotate' ? (
                    <span>· {t('editor.annotate_hint_short')}</span>
                  ) : (
                    <span>· {t('editor.edit_hint_short')}</span>
                  )}
                </div>
                <div className="mt-2">
                  {tab === 'redact' ? (
                    <EditorCanvas
                      bytes={source.bytes}
                      page={currentPage}
                      version={genRef.current}
                      marks={pageMarks}
                      onAdd={addMark}
                      onRemove={removeMark}
                      disabled={busy}
                    />
                  ) : tab === 'annotate' ? (
                    <AnnotateCanvasArea
                      state={annotate}
                      bytes={source.bytes}
                      page={currentPage}
                      version={genRef.current}
                      visualWidth={pageVisual?.width ?? 0}
                      disabled={busy}
                    />
                  ) : (
                    <EditTextArea
                      state={editText}
                      bytes={source.bytes}
                      page={currentPage}
                      version={genRef.current}
                    />
                  )}
                </div>
                {tab === 'redact' && report ? (
                  <div className="mt-3 rounded-lg border border-border-default bg-surface-card p-3 text-[13px] leading-relaxed">
                    <p className="font-bold">{t('redact.report_title')}</p>
                    <p className="mt-1">
                      {t('redact.report_surgical', { count: report.surgical.length })} ·{' '}
                      {t('redact.report_raster', { count: report.raster.length })} ·{' '}
                      {t('redact.report_blocks', { count: report.removedBlocks })}
                    </p>
                    {report.escalated.length > 0 ? (
                      <p className="mt-1">{t('redact.report_escalated', { pages: report.escalated.join(', ') })}</p>
                    ) : null}
                    {report.scrub.length > 0 ? (
                      <p className="mt-1">
                        {t('redact.scrub_list', {
                          list: report.scrub.map((s) => `${s.channel} (${s.sample})`).join(', '),
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-4">
                  <ThumbnailStrip
                    pages={Array.from({ length: numPages }, (_, i) => i + 1).map((p) => ({
                      key: `p${p}`,
                      pageNumber: p,
                      url: urlFor(`p${p}`),
                      selected: p === currentPage,
                    }))}
                    fullscreenTitle={(n) => t('a11y.page_n', { n })}
                    closeLabel={t('home.sheet_close')}
                    register={observe}
                    onToggle={(pageNumber: number) => setCurrentPage(pageNumber)}
                  />
                </div>
              </>
            ) : (
              <p className="mt-3 text-[13px] text-text-muted">{t('editor.tab_placeholder')}</p>
            )}
          </div>
        </>
      ) : null}
    </WorkspaceShell>
  );
}
