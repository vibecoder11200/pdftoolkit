import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Dropzone } from '../ui/dropzone';
import { useDropFiles } from '../../hooks/use-tool-files';
import { renderPageToCanvas, getPageCount, getFirstPageText } from '../../engine/pdfjs';
import {
  OCR_PAGE_CAP,
  createOcrSession,
  foldSearchablePdfParts,
  mergeSearchablePdfParts,
  OCR_FOLD_EVERY,
  OcrAbortedError,
  type OcrLangs,
} from '../../lib/ocr';
import { deliverBytes } from '../../lib/download';
import { beginJob, endJob } from '../../lib/jobs';
import { AI_MODEL_ID, isModelCachedLocally } from '../../lib/ai-models';
import {
  aiTierEstimate,
  downloadIfNeeded,
  runAiPages,
  type AiPageResult,
  type AiRunClient,
} from '../../lib/ai-run';
import { sharedAiClient } from '../../lib/ai-worker-client';
import { convertEngineOutput } from '../../lib/ai-markdown';
import {
  AI_TUNING_PRESETS,
  estimateForCurrentChoice,
  type AiFootprintEstimate,
  type AiTuning,
} from '../../lib/ai-preflight';
import {
  adapterDisplayLabel,
  probeAdapters,
  resolveCurrentChoice,
  type AdapterDiscovery,
  type ResolvedGpuChoice,
} from '../../lib/gpu-choice';
import { useGpuChoice } from '../../hooks/use-gpu-choice';
import { useGpuFallback } from '../../hooks/use-gpu-fallback';
import type { TierResolution } from '../../lib/capability';
import type { RasterImageData } from '../../workers/pdf.worker';

/*
 * OCR tool (plan v0.4.0 phase 5, D7/R8/R14/R20; v0.5.0 phase 4a adds the
 * AI engine): single PDF → engine choice. Tesseract keeps the v0.4.0 path
 * 100% intact (searchable PDF + per-page text). The AI engine (GLM-OCR,
 * on-device) outputs STRUCTURED text — md/txt/html; a searchable PDF is a
 * TESSERACT feature by decision D5-amended, and the copy says so. Pages
 * render lazily one at a time (no raster pile-up), cancel stops at the
 * page boundary keeping results, and a worker crash offers resume from the
 * failed page (F6).
 */

type LangChoice = 'auto' | OcrLangs;
type Step = 'pick' | 'config' | 'running' | 'done';
type Engine = 'tesseract' | 'ai';
type AiPhase = 'idle' | 'downloading' | 'loading' | 'running' | 'done' | 'error';

const DPI_CHOICES = [150, 200, 300] as const;
// Per-page seconds at A4 from the phase-4b benchmarks (~0.5s/page at 200dpi,
// eng ≈ vie, 0.43-0.83s observed variance; 300dpi scales ~2.25× by pixels).
const ESTIMATE_S_PER_PAGE: Record<number, number> = { 150: 0.4, 200: 0.6, 300: 1.4 };
// AI render dpi — the worker caps the long edge at 1024px anyway (SPIKE),
// so 150dpi (~1240px at A4) is the sweet spot.
const AI_DPI = 150;

interface PageResult {
  page: number;
  text: string;
  confidence: number;
  ms: number;
}

/** e2e mock seam (F8): `?ai-mock=1` on the PAGE url drives the canned engine. */
const isAiMock = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ai-mock');

/**
 * Honest "requesting X" text for the status line — the adapter label is
 * adapterDisplayLabel (shared with Settings; adapter-reported driver strings
 * render as plain React text only, SEC-3).
 */
function gpuRequestLabel(
  request: ResolvedGpuChoice | null,
  discovery: AdapterDiscovery | null,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (!request) return t('ocr.gpu_status_unknown');
  if (request.kind === 'cpu') return t('ocr.gpu_status_cpu');
  const adapter = discovery?.adapters.find((a) => a.fingerprint === request.fingerprint);
  return adapter ? adapterDisplayLabel(adapter) : request.fingerprint;
}

export function OcrTool() {
  const { t } = useTranslation();
  const { files, error, add, clear } = useDropFiles();
  const [step, setStep] = useState<Step>('pick');
  const [engine, setEngine] = useState<Engine>('tesseract');
  const [lang, setLang] = useState<LangChoice>('auto');
  const [dpi, setDpi] = useState<(typeof DPI_CHOICES)[number]>(150);
  const [hasTextLayer, setHasTextLayer] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const [tooManyPages, setTooManyPages] = useState(false);

  const [resolvedLang, setResolvedLang] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [results, setResults] = useState<PageResult[]>([]);
  const [phase, setPhase] = useState<'running' | 'cancelling' | 'dropped'>('running');
  const [outBytes, setOutBytes] = useState<Uint8Array | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [totalMs, setTotalMs] = useState(0);

  // AI engine state
  const [aiLabel, setAiLabel] = useState<{ cached: boolean; tier: TierResolution | null } | null>(null);
  const [aiPhase, setAiPhase] = useState<AiPhase>('idle');
  const [aiDownload, setAiDownload] = useState<{ percent: number | null; started: boolean }>({
    percent: null,
    started: false,
  });
  const [aiPage, setAiPage] = useState({ current: 0, total: 0 });
  const [aiTokens, setAiTokens] = useState(0);
  const [aiResults, setAiResults] = useState<AiPageResult[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiCrashedAt, setAiCrashedAt] = useState<number | null>(null);
  const [aiTab, setAiTab] = useState<'md' | 'txt' | 'html'>('md');
  // GPU selection state (plan 261009-0836 phases 3+4)
  const gpuChoice = useGpuChoice();
  const gpuFallback = useGpuFallback();
  const [gpuRequest, setGpuRequest] = useState<ResolvedGpuChoice | null>(null);
  const [gpuDiscovery, setGpuDiscovery] = useState<AdapterDiscovery | null>(null);
  const [preflight, setPreflight] = useState<AiFootprintEstimate | null>(null);
  const [aiTuning, setAiTuning] = useState<'full' | 'reduced'>('full');
  const [resumeReask, setResumeReask] = useState(false);

  const abortRef = useRef(false);
  const dropAllRef = useRef(false);
  const clientRef = useRef<AiRunClient | null>(null);

  useEffect(() => {
    (async () => {
      if (files.length === 0) {
        setStep('pick');
        return;
      }
      setStep('config');
      const bytes = files[0].bytes;
      const count = await getPageCount(bytes);
      setPageCount(count);
      setTooManyPages(count > OCR_PAGE_CAP);
      const text = await getFirstPageText(bytes);
      setHasTextLayer(text.length >= 32);
    })().catch(() => setStep('pick'));
  }, [files]);

  // AI label (D4 pre-download): tier estimate + zero-network cached check.
  useEffect(() => {
    if (step !== 'config') return;
    let cancelled = false;
    void (async () => {
      const tier = await aiTierEstimate().catch(() => null);
      const cached = await isModelCachedLocally();
      if (!cancelled) setAiLabel({ cached, tier });
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  // Live "requesting X" status (phase 4): the RESOLVED request for the
  // current choice — the app can only REQUEST; the OS may deliver another
  // adapter (the honest phrasing never claims otherwise). Re-probes when
  // the choice changes, no app restart. Tesseract never shows the line, so
  // it probes only for the AI engine (fresh at the moment it renders).
  useEffect(() => {
    if (step !== 'config' || engine !== 'ai') return;
    let cancelled = false;
    void (async () => {
      try {
        const discovery = await probeAdapters();
        const { resolved } = resolveCurrentChoice(discovery);
        if (!cancelled) {
          setGpuDiscovery(discovery);
          setGpuRequest(resolved);
        }
      } catch {
        if (!cancelled) setGpuRequest({ kind: 'cpu' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, engine, gpuChoice]);

  // Phase-3 preflight estimate for the resolved target.
  useEffect(() => {
    if (step !== 'config' || engine !== 'ai') return;
    let cancelled = false;
    void estimateForCurrentChoice().then((estimate) => {
      if (!cancelled) setPreflight(estimate);
    });
    return () => {
      cancelled = true;
    };
  }, [step, engine, gpuChoice]);

  const estimate = useMemo(() => {
    const perPage = ESTIMATE_S_PER_PAGE[dpi] * (lang === 'auto' ? 1.1 : 1);
    const total = Math.round((perPage * pageCount) / 60);
    return total >= 1 ? t('ocr.estimate_minutes', { count: total }) : t('ocr.estimate_under_minute');
  }, [dpi, lang, pageCount, t]);

  const aiClient = useCallback((): AiRunClient => {
    if (!clientRef.current) {
      clientRef.current = sharedAiClient({ mock: isAiMock() });
    }
    return clientRef.current;
  }, []);

  const runAi = useCallback(
    async (startPage: number, keep: AiPageResult[], tuning: AiTuning = AI_TUNING_PRESETS.full) => {
      if (files.length === 0) return;
      beginJob('ai-ocr');
      setStep('running');
      setAiError(null);
      setAiCrashedAt(null);
      setResumeReask(false);
      setAiTokens(keep.reduce((s, r) => s + r.genTokens, 0));
      setAiResults(keep);
      abortRef.current = false;
      const client = aiClient();
      const bytes = files[0].bytes;
      const canvas = document.createElement('canvas');
      const scale = AI_DPI / 72;
      const renderPage = async (page: number): Promise<RasterImageData> => {
        await renderPageToCanvas(bytes, page, canvas, scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d context unavailable');
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return { data: image.data, width: image.width, height: image.height };
      };
      try {
        setAiPhase('downloading');
        setAiDownload({ percent: null, started: true });
        await downloadIfNeeded(client, AI_MODEL_ID, (p) => {
          setAiDownload({ percent: p.percent, started: true });
        });
        setAiPhase('loading');
        const out = await runAiPages(
          client,
          pageCount,
          renderPage,
          {
            onPage: (c, total) => {
              setAiPhase('running');
              setAiPage({ current: c, total });
            },
            onToken: () => setAiTokens((n) => n + 1),
            onCrash: (failedAtPage) => setAiCrashedAt(failedAtPage),
          },
          {
            startPage,
            shouldContinue: () => !abortRef.current,
            // Phase-3 preflight tuning, threaded per page.
            maxNewTokensPerPage: tuning.maxNewTokens,
            maxLongEdgePerPage: tuning.maxLongEdge,
            // A non-full tuning must not pollute the per-adapter benchmark
            // records (phase 4 keys measurements by adapter fingerprint).
            benchmarkRecord: tuning.maxLongEdge === 1024 && tuning.maxNewTokens === 4096,
          },
        );
        setAiResults([...keep, ...out.results]);
        setAiPhase('done');
        setStep('done');
      } catch (err) {
        setAiError(err instanceof Error ? err.message : String(err));
        setAiPhase('error');
        setStep('done');
      } finally {
        endJob('ai-ocr');
      }
    },
    [aiClient, files, pageCount],
  );

  /**
   * Resume (red-team F8): the resume path never re-enters the config card,
   * and it is exactly when the fallback chain may have moved the engine to
   * a tighter configuration — re-run the preflight; if it is now tight and
   * the crash-time tuning was FULL, re-ask instead of silently running.
   */
  const resumeAi = useCallback(
    async (startPage: number, keep: AiPageResult[]) => {
      const estimate = await estimateForCurrentChoice().catch(() => null);
      if (estimate?.tight && aiTuning === 'full') {
        setResumeReask(true);
        return;
      }
      void runAi(startPage, keep, AI_TUNING_PRESETS[aiTuning]);
    },
    [aiTuning, runAi],
  );

  const start = useCallback(() => {
    if (files.length === 0) return;
    // The config step renders BEFORE the async page-count probe resolves —
    // never start with a stale/zero count (assertPageCountOk would throw).
    if (pageCount < 1 || pageCount > OCR_PAGE_CAP) return;
    if (engine === 'ai') {
      void runAi(1, [], AI_TUNING_PRESETS[aiTuning]);
      return;
    }
    setStep('running');
    setPhase('running');
    setResults([]);
    setCurrent(0);
    setResolvedLang(null);
    setOutBytes(null);
    setRunError(null);
    abortRef.current = false;
    dropAllRef.current = false;
    const bytes = files[0].bytes;
    const canvas = document.createElement('canvas');
    const scale = dpi / 72;

    void (async () => {
      // F22: a desktop update must confirm before restarting over this job.
      beginJob('ocr');
      const t0 = performance.now();
      let langs: OcrLangs;
      let session;
      try {
        if (lang === 'auto') {
          // Auto (user 2026-10-07): page 1 through BOTH langs, keep the higher
          // mean confidence. Two sessions, disposed immediately (the +1 page
          // cost is the documented price of not shipping OSD).
          setCurrent(1);
          await renderPageToCanvas(bytes, 1, canvas, scale);
          const [eng, vie] = await Promise.all([
            (async () => {
              const s = await createOcrSession({ langs: 'eng' });
              try {
                return await s.recognizeText(canvas);
              } finally {
                await s.dispose();
              }
            })(),
            (async () => {
              const s = await createOcrSession({ langs: 'vie' });
              try {
                return await s.recognizeText(canvas);
              } finally {
                await s.dispose();
              }
            })(),
          ]);
          langs = vie.confidence > eng.confidence ? 'vie' : 'eng';
          setResolvedLang(langs);
        } else {
          langs = lang;
          setResolvedLang(langs);
        }
        session = await createOcrSession({ langs });
        const parts: Uint8Array[] = [];
        const pending: Uint8Array[] = [];
        const collected: PageResult[] = [];
        for (let page = 1; page <= pageCount; page += 1) {
          if (dropAllRef.current) return;
          setCurrent(page);
          const pageStart = performance.now();
          await renderPageToCanvas(bytes, page, canvas, scale);
          const { text, confidence, pdf } = await session.recognizePage(canvas);
          const ms = Math.round(performance.now() - pageStart);
          collected.push({ page, text, confidence, ms });
          pending.push(pdf);
          setResults([...collected]);
          if (pending.length >= OCR_FOLD_EVERY) {
            // R8: fold every K pages and drop the merged inputs so peak
            // memory stays bounded on 100-page scans.
            parts.push(await mergeSearchablePdfParts(pending));
            pending.length = 0;
          }
          if (abortRef.current) break;
        }
        if (dropAllRef.current) return;
        const all = pending.length > 0 ? [...parts, ...(await foldSearchablePdfParts(pending))] : parts;
        setOutBytes(await mergeSearchablePdfParts(all));
        setTotalMs(Math.round(performance.now() - t0));
        setStep('done');
      } catch (err) {
        if (err instanceof OcrAbortedError || abortRef.current) {
          setPhase('cancelling');
          setStep('done');
          return;
        }
        setRunError(err instanceof Error ? err.message : String(err));
        setStep('config');
      } finally {
        await session?.dispose();
        endJob('ocr');
      }
    })();
  }, [aiTuning, dpi, engine, files, lang, pageCount, runAi]);

  const cancelAiDownload = useCallback(() => {
    void aiClient().cancelDownload();
    abortRef.current = true;
  }, [aiClient]);

  if (step === 'pick') {
    return (
      <section className="grid gap-4">
        <Dropzone
          onFiles={add}
          multiple={false}
          title={t('ocr.drop_title')}
          hint={t('ocr.drop_hint')}
          accept="application/pdf,.pdf"
        />
        {/* same convention as extract/merge: the raw drop verdict */}
        {error && <p role="alert" className="text-sm text-tone-red">{error}</p>}
      </section>
    );
  }

  if (step === 'config') {
    const tier = aiLabel?.tier;
    const tierKey =
      tier?.tier === 'gpu-strong'
        ? 'ocr.ai_tier_strong'
        : tier?.tier === 'gpu-weak'
          ? 'ocr.ai_tier_weak'
          : tier?.tier === 'cpu'
            ? 'ocr.ai_tier_cpu'
            : 'ocr.ai_tier_none';
    // the mock seam (F8) runs on any machine — the tier gate is for the
    // real engine only
    const aiUnavailable = !isAiMock() && tier?.tier === 'none';
    return (
      <section className="grid gap-4">
        <header className="grid gap-1">
          <h2 className="text-lg font-bold">{files[0]?.file.name}</h2>
          <p className="text-sm text-text-muted">{t('ocr.page_count', { count: pageCount })}</p>
        </header>
        {tooManyPages && (
          <p role="alert" className="rounded-lg border border-tone-red bg-tone-red-soft px-4 py-3 text-sm">
            {t('ocr.page_cap', { count: pageCount, cap: OCR_PAGE_CAP })}
          </p>
        )}
        {!tooManyPages && hasTextLayer && (
          <p className="rounded-lg border border-border-strong bg-surface-card px-4 py-3 text-sm">
            {t('ocr.has_text_warning')}
          </p>
        )}
        <fieldset className="grid gap-2">
          <legend className="text-sm font-bold">{t('ocr.engine_q')}</legend>
          {(['tesseract', 'ai'] as Engine[]).map((choice) => (
            <label
              key={choice}
              className={`grid gap-1 rounded-lg border px-3.5 py-2.5 text-sm ${
                engine === choice ? 'border-accent bg-surface-card' : 'border-border-strong'
              } ${choice === 'ai' && aiUnavailable ? 'opacity-60' : ''}`}
            >
              <span className="flex min-h-6 items-center gap-2 font-semibold">
                <input
                  type="radio"
                  name="ocr-engine"
                  checked={engine === choice}
                  onChange={() => setEngine(choice)}
                />
                {choice === 'tesseract' ? t('ocr.engine_tesseract') : t('ocr.engine_ai')}
                {choice === 'ai' && aiLabel?.cached && (
                  <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs font-normal text-accent">
                    {t('ocr.ai_state_ready')}
                  </span>
                )}
              </span>
              <span className="text-xs text-text-muted">
                {choice === 'tesseract' ? t('ocr.engine_tesseract_hint') : t('ocr.engine_ai_hint')}
              </span>
              {choice === 'ai' && tier && (
                <span className="text-xs text-text-muted">
                  {t(tierKey)}
                  {tier.source === 'measured'
                    ? ` · ${t('ocr.tier_measured')}`
                    : ` · ${t('ocr.tier_estimate')}`}
                </span>
              )}
            </label>
          ))}
        </fieldset>
        {engine === 'tesseract' && (
          <>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-bold">{t('ocr.lang_q')}</legend>
              {(['auto', 'vie', 'eng', 'vie+eng'] as LangChoice[]).map((choice) => (
                <label key={choice} className="flex min-h-9 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ocr-lang"
                    checked={lang === choice}
                    onChange={() => setLang(choice)}
                  />
                  {t(`ocr.lang_${choice.replace('+', '_')}`)}
                </label>
              ))}
            </fieldset>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-bold">{t('ocr.dpi_q')}</legend>
              <div className="flex gap-2">
                {DPI_CHOICES.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={dpi === d}
                    className={`min-h-9 rounded-lg border px-3.5 text-sm ${
                      dpi === d ? 'border-accent bg-surface-card font-semibold' : 'border-border-strong'
                    }`}
                    onClick={() => setDpi(d)}
                  >
                    {d} DPI
                  </button>
                ))}
              </div>
            </fieldset>
            <p className="text-sm text-text-muted">{estimate}</p>
          </>
        )}
        {engine === 'ai' && (
          <>
            <p className="rounded-lg border border-border-strong bg-surface-card px-4 py-3 text-xs text-text-muted">
              {t('ocr.ai_notice')}
            </p>
            {/* Live "requesting" status (phase 4): the app only requests an
                adapter — the OS may deliver another one. */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted" data-testid="ocr-gpu-status">
              <span>
                {t('ocr.gpu_status_requesting', {
                  target: gpuRequestLabel(gpuRequest, gpuDiscovery, t),
                })}
              </span>
              <Link
                to="/settings"
                className="rounded border border-border-strong px-2 py-0.5 hover:bg-surface-hover"
              >
                {t('ocr.gpu_status_change')}
              </Link>
            </div>
            {gpuFallback && (
              <p className="rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400" role="status">
                {t('ocr.gpu_fallback_note', {
                  target: gpuFallback.to === 'cpu' ? t('ocr.gpu_fallback_cpu') : gpuFallback.to,
                  reason: gpuFallback.reason,
                })}
              </p>
            )}
            {/* Phase-3 preflight choice card: ASK, never decide. Non-blocking
                inline card (quick-guide strip pattern); this run only. */}
            {preflight?.tight && (
              <fieldset className="grid gap-2 rounded-lg border border-border-strong px-3.5 py-3" data-testid="ocr-preflight-card">
                <legend className="text-sm font-bold">{t('ocr.preflight_tight_title')}</legend>
                <p className="text-xs text-text-muted">
                  {t('ocr.preflight_basis_note', { basis: t(`ocr.preflight_basis_${preflight.basis}`) })}
                </p>
                {(['full', 'reduced'] as const).map((preset) => (
                  <label key={preset} className="grid gap-0.5 text-sm">
                    <span className="flex min-h-6 items-center gap-2 font-semibold">
                      <input
                        type="radio"
                        name="ai-tuning"
                        checked={aiTuning === preset}
                        onChange={() => setAiTuning(preset)}
                      />
                      {t(`ocr.preflight_${preset}`)}
                    </span>
                    <span className="pl-6 text-xs text-text-muted">{t(`ocr.preflight_${preset}_hint`)}</span>
                  </label>
                ))}
                <p className="text-xs text-text-muted">
                  {t('ocr.preflight_tesseract_hint')}
                </p>
              </fieldset>
            )}
          </>
        )}
        {runError && <p role="alert" className="text-sm text-tone-red">{runError}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={tooManyPages || pageCount < 1 || (engine === 'ai' && aiUnavailable)}
            className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent disabled:opacity-50"
            onClick={start}
          >
            {engine === 'ai' && !aiLabel?.cached ? t('ocr.run_ai_download') : t('ocr.run')}
          </button>
          <button
            type="button"
            className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm"
            onClick={() => {
              clear();
              setStep('pick');
            }}
          >
            {t('ocr.change_file')}
          </button>
        </div>
      </section>
    );
  }

  if (step === 'running') {
    if (engine === 'ai') {
      const pct = aiPage.total > 0 ? Math.round((aiPage.current / aiPage.total) * 100) : 0;
      return (
        <section className="grid gap-4" aria-busy>
          {aiPhase === 'downloading' && (
            <div role="progressbar" aria-valuenow={aiDownload.percent ?? undefined} aria-valuemin={0} aria-valuemax={100} className="grid gap-1">
              <p className="text-sm font-semibold">
                {t('ocr.ai_download_progress', { percent: aiDownload.percent ?? 0 })}
              </p>
              <div className="h-2 overflow-hidden rounded-full bg-surface-card">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${aiDownload.percent ?? 0}%` }}
                />
              </div>
              <button
                type="button"
                data-testid="ai-cancel-download"
                className="min-h-9 w-fit rounded-lg border border-border-strong px-3.5 text-sm"
                onClick={cancelAiDownload}
              >
                {t('ocr.ai_cancel_download')}
              </button>
              <p className="text-xs text-text-muted">{t('ocr.ai_download_hint')}</p>
            </div>
          )}
          {aiPhase === 'loading' && <p className="text-sm font-semibold">{t('ocr.ai_loading')}</p>}
          {(aiPhase === 'running' || aiPhase === 'done') && (
            <div className="grid gap-1">
              <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="grid gap-1">
                <p className="text-sm font-semibold">
                  {t('ocr.ai_progress_page', { current: aiPage.current, count: aiPage.total })}
                  <span className="ml-2 font-normal text-text-muted">
                    {t('ocr.ai_tokens', { tokens: aiTokens })}
                  </span>
                </p>
                <div className="h-2 overflow-hidden rounded-full bg-surface-card">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <button
                type="button"
                className="min-h-9 w-fit rounded-lg border border-border-strong px-3.5 text-sm"
                onClick={() => {
                  abortRef.current = true;
                }}
              >
                {t('ocr.cancel_soft')}
              </button>
              <p className="text-xs text-text-muted">{t('ocr.ai_cancel_hint')}</p>
            </div>
          )}
        </section>
      );
    }
    const pct = pageCount > 0 ? Math.round((current / pageCount) * 100) : 0;
    return (
      <section className="grid gap-4" aria-busy>
        <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="grid gap-1">
          <p className="text-sm font-semibold">
            {t('ocr.progress_page', { current, count: pageCount })}
            {resolvedLang && lang === 'auto' && ` · ${t(`ocr.lang_${resolvedLang.replace('+', '_')}`)}`}
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-surface-card">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm"
            onClick={() => {
              abortRef.current = true;
            }}
          >
            {t('ocr.cancel_soft')}
          </button>
          <button
            type="button"
            className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm text-tone-red"
            onClick={() => {
              dropAllRef.current = true;
              abortRef.current = true;
              setPhase('dropped');
              setStep('config');
            }}
          >
            {t('ocr.cancel_all')}
          </button>
        </div>
        <p className="text-xs text-text-muted">{t('ocr.cancel_hint')}</p>
      </section>
    );
  }

  // done — AI results (v1: text) or tesseract results (partial soft-cancel
  // looks the same, with a note).
  if (engine === 'ai') {
    const text = aiResults
      .slice()
      .sort((a, b) => a.page - b.page)
      .map((r) => `--- ${t('ocr.page_n', { page: r.page })} ---\n${r.text}`)
      .join('\n\n');
    // D10: markdown/html are built by the escape-then-format converter; the
    // preview iframe is sandboxed WITHOUT allow-scripts — OCR text is
    // untrusted (adversarial e2e pins this).
    const converted = convertEngineOutput(text);
    const baseName = (files[0]?.file.name ?? 'document.pdf').replace(/\.pdf$/i, '');
    const tabs: Array<{ id: 'md' | 'txt' | 'html'; label: string }> = [
      { id: 'md', label: t('ocr.tab_markdown') },
      { id: 'txt', label: t('ocr.tab_text') },
      { id: 'html', label: t('ocr.tab_html') },
    ];
    return (
      <section className="grid gap-4">
        <p className="rounded-lg border border-border-strong bg-surface-card px-4 py-3 text-sm">
          {t('ocr.ai_no_searchable')}
        </p>
        {aiCrashedAt !== null && (
          <div className="rounded-lg border border-tone-red bg-tone-red-soft px-4 py-3 text-sm" role="alert">
            <p>{t('ocr.ai_resume', { page: aiCrashedAt })}</p>
            {resumeReask ? (
              // F8 resume re-ask: the adapter situation changed after the
              // crash — the full-mode choice is re-offered, not assumed.
              <div className="mt-2 grid gap-2" data-testid="ocr-resume-reask">
                <p className="text-xs text-text-muted">{t('ocr.preflight_tight_title')}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="ocr-resume-reduced"
                    className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
                    onClick={() => void runAi(aiCrashedAt, aiResults, AI_TUNING_PRESETS.reduced)}
                  >
                    {t('ocr.preflight_reduced_resume')}
                  </button>
                  <button
                    type="button"
                    className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm"
                    onClick={() => void runAi(aiCrashedAt, aiResults, AI_TUNING_PRESETS.full)}
                  >
                    {t('ocr.preflight_full_resume')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                data-testid="ai-resume"
                className="mt-2 min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
                onClick={() => void resumeAi(aiCrashedAt, aiResults)}
              >
                {t('ocr.ai_resume_button', { page: aiCrashedAt })}
              </button>
            )}
          </div>
        )}
        {aiError && aiCrashedAt === null && (
          <p role="alert" className="text-sm text-tone-red">{t('ocr.ai_error', { message: aiError })}</p>
        )}
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={t('ocr.engine_ai')}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={aiTab === tab.id}
              className={`min-h-9 rounded-lg border px-3.5 text-sm ${
                aiTab === tab.id ? 'border-accent bg-surface-card font-semibold' : 'border-border-strong'
              }`}
              onClick={() => setAiTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ['md', converted.markdown, `${baseName}-ocr.md`, 'text/markdown', t('ocr.download_md')],
              ['txt', converted.text, `${baseName}-ocr.txt`, 'text/plain', t('ocr.download_txt')],
              ['html', converted.html, `${baseName}-ocr.html`, 'text/html', t('ocr.download_html')],
            ] as const
          ).map(([id, content, name, mime, label]) => (
            <button
              key={id}
              type="button"
              disabled={content.length === 0}
              className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm disabled:opacity-50"
              onClick={() => void deliverBytes(new TextEncoder().encode(content), name, 'download', mime)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="ml-auto rounded border border-border-strong px-2 py-1 text-xs"
            onClick={() =>
              void navigator.clipboard.writeText(
                aiTab === 'md' ? converted.markdown : aiTab === 'html' ? converted.html : converted.text,
              )
            }
          >
            {t('ocr.copy_all')}
          </button>
        </div>
        {aiTab === 'md' && (
          <pre data-testid="ai-markdown" className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border-strong bg-surface-card p-3 text-xs">{converted.markdown}</pre>
        )}
        {aiTab === 'txt' && (
          <pre data-testid="ai-text" className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border-strong bg-surface-card p-3 text-xs">{converted.text}</pre>
        )}
        {aiTab === 'html' && (
          <iframe
            data-testid="ai-html-preview"
            sandbox=""
            title={t('ocr.tab_html')}
            srcDoc={converted.html}
            className="h-96 w-full rounded-lg border border-border-strong bg-white"
          />
        )}
      </section>
    );
  }
  return (
    <section className="grid gap-4">
      {phase === 'cancelling' && (
        <p className="rounded-lg border border-border-strong bg-surface-card px-4 py-3 text-sm">
          {t('ocr.cancelled_partial', { count: results.length })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!outBytes}
          className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent disabled:opacity-50"
          onClick={() =>
            outBytes &&
            void deliverBytes(
              outBytes,
              `${(files[0]?.file.name ?? 'document.pdf').replace(/\.pdf$/i, '')}-ocr.pdf`,
              'download',
            )
          }
        >
          {t('ocr.download_pdf')}
        </button>
        <button
          type="button"
          className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm"
          onClick={() => {
            clear();
            setResults([]);
            setOutBytes(null);
            setStep('pick');
          }}
        >
          {t('ocr.another')}
        </button>
        {totalMs > 0 && (
          <span className="text-sm text-text-muted">{t('ocr.total_time', { seconds: Math.round(totalMs / 1000) })}</span>
        )}
      </div>
      <ol className="grid gap-2">
        {results.map((r) => (
          <li key={r.page} className="grid gap-1 rounded-lg border border-border-strong bg-surface-card p-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {t('ocr.page_n', { page: r.page })}
              <span className="font-normal text-text-muted">
                {r.ms} ms · {Math.round(r.confidence)}%
              </span>
              <button
                type="button"
                className="ml-auto rounded border border-border-strong px-2 py-1 text-xs"
                onClick={() => void navigator.clipboard.writeText(r.text)}
              >
                {t('ocr.copy_page')}
              </button>
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-text-muted">{r.text}</pre>
          </li>
        ))}
      </ol>
    </section>
  );
}
