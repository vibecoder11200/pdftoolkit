import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

/*
 * OCR tool (plan v0.4.0 phase 5, D7/R8/R14/R20): single PDF → searchable PDF
 * + per-page text. Language Auto resolves by running page 1 through BOTH
 * vie and eng and keeping the higher mean confidence (no OSD — non-goal);
 * the choice is surfaced and overridable. Page cap 100 is HARD (D7) — the
 * config step refuses above it; a PDF that already carries a text layer gets
 * a warning instead. Cancel stops at the page boundary ("dừng sau trang
 * hiện tại") keeping partial results; "Hủy tất" drops everything.
 */

type LangChoice = 'auto' | OcrLangs;
type Step = 'pick' | 'config' | 'running' | 'done';

const DPI_CHOICES = [150, 200, 300] as const;
// Per-page seconds at A4 from the phase-4b benchmarks (~0.5s/page at 200dpi,
// eng ≈ vie, 0.43-0.83s observed variance; 300dpi scales ~2.25× by pixels).
const ESTIMATE_S_PER_PAGE: Record<number, number> = { 150: 0.4, 200: 0.6, 300: 1.4 };

interface PageResult {
  page: number;
  text: string;
  confidence: number;
  ms: number;
}

export function OcrTool() {
  const { t } = useTranslation();
  const { files, error, add, clear } = useDropFiles();
  const [step, setStep] = useState<Step>('pick');
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

  const abortRef = useRef(false);
  const dropAllRef = useRef(false);

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

  const estimate = useMemo(() => {
    const perPage = ESTIMATE_S_PER_PAGE[dpi] * (lang === 'auto' ? 1.1 : 1);
    const total = Math.round((perPage * pageCount) / 60);
    return total >= 1 ? t('ocr.estimate_minutes', { count: total }) : t('ocr.estimate_under_minute');
  }, [dpi, lang, pageCount, t]);

  const start = useCallback(() => {
    if (files.length === 0) return;
    // The config step renders BEFORE the async page-count probe resolves —
    // never start with a stale/zero count (assertPageCountOk would throw).
    if (pageCount < 1 || pageCount > OCR_PAGE_CAP) return;
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
      }
    })();
  }, [dpi, files, lang, pageCount]);

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
        {runError && <p role="alert" className="text-sm text-tone-red">{runError}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={tooManyPages || pageCount < 1}
            className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent disabled:opacity-50"
            onClick={start}
          >
            {t('ocr.run')}
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

  // done — partial results (soft cancel) look the same, with a note.
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
