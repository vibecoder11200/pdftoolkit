import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { takePendingFiles } from '../../lib/handoff';
import { getVisualTextItems } from '../../engine/pdfjs';
import {
  PDF2WORD_PAGE_CAP,
  Pdf2WordItemCapError,
  Pdf2WordPageCapError,
  Pdf2WordScanError,
  censusMode,
  censusSample,
  runPdf2Word,
} from '../../lib/pdf2word';
import { engine as pdfEngine } from '../../engine/client';
import { deliverBytes } from '../../lib/download';
import { beginJob, endJob } from '../../lib/jobs';
import { AI_MODEL_ID } from '../../lib/ai-models';
import { aiTierEstimate, downloadIfNeeded, runAiPages, type AiRunClient } from '../../lib/ai-run';
import { sharedAiClient } from '../../lib/ai-worker-client';
import { sharedNativeClient } from '../../lib/ai-native-client';
import { isTauri } from '../../lib/platform';
import type { RasterImageData } from '../../workers/pdf.worker';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { Hint } from '../ui/hint';
import { WorkspaceShell } from './workspace-shell';
import { ThumbnailStrip } from './thumbnail-strip';
import { useThumbnails } from '../../hooks/use-thumbnails';

/*
 * PDF → Word (tool #18, v0.10.0 phase 5). Terminal tool for PDF chaining:
 * acceptsPdf makes it a chip DESTINATION exactly like ocr/pdf-to-img, but
 * its DOCX output is not a PDF — it is NEVER a chip host (no ContinueChip,
 * nothing retained; the v0.8.0 host enumeration stays untouched, F4).
 *
 * Mode card (F6): the pipeline census PRE-HIGHLIGHTS the detected mode
 * only — running the AI scan route requires an explicit confirm (the
 * ~652MB one-time model note + the cpu-tier slow warning), never an
 * auto-engage. The digital path never fake-OCRs; a scan page reached on
 * the digital path refuses with a typed error instead.
 */

type ModeChoice = 'auto' | 'digital' | 'scan';
type Detected = 'digital' | 'scan' | 'mixed' | null;

const AI_DPI = 150; // worker caps long edge at 1024 anyway (OCR precedent)

export function PdfToWordTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  // Home-sheet handoff: one-shot take (StrictMode-safe, pdf-to-img pattern).
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);

  const [numPages, setNumPages] = useState(0);
  const [detected, setDetected] = useState<Detected>(null);
  const [mode, setMode] = useState<ModeChoice>('auto');
  const [selectedPages, setSelectedPages] = useState<Set<number> | null>(null);
  const [scanConfirm, setScanConfirm] = useState(false);
  const [slowTier, setSlowTier] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';

  const src = files.length > 0 ? files[0] : null;
  const probeRef = useRef<Promise<number> | null>(null);
  const abortRef = useRef(false);
  const genRef = useRef(0);

  const { urlFor: thumbUrlFor, observe: thumbObserve } = useThumbnails(
    src && numPages > 0
      ? Array.from({ length: numPages }, (_, i) => ({
          id: `p2w-${i + 1}`,
          bytes: src.bytes,
          page: i + 1,
        }))
      : [],
  );
  const thumbPages = Array.from({ length: numPages }, (_, i) => {
    const pageNumber = i + 1;
    return {
      key: `p2w-${pageNumber}`,
      pageNumber,
      url: thumbUrlFor(`p2w-${pageNumber}`),
      selected: selectedPages ? selectedPages.has(pageNumber) : true,
    };
  });

  // Probe + census. The probe is awaited before ANY run decision (the split
  // gate: `error_unreadable` means the probe FAILED, never "still loading").
  // The census reads only the first/middle/last sample (F1's explicit rule).
  useEffect(() => {
    const gen = (genRef.current += 1);
    setDetected(null);
    setNumPages(0);
    setSelectedPages(null);
    setScanConfirm(false);
    setDone(false);
    setErrorKey(null);
    setErrorDetail(null);
    setProgress(null);
    if (!src) {
      probeRef.current = null;
      return;
    }
    const probe = (async (): Promise<number> => {
      const { info } = await pdfEngine.loadPdf(src.bytes);
      if (info.numPages > PDF2WORD_PAGE_CAP) throw new Pdf2WordPageCapError(info.numPages);
      return info.numPages;
    })();
    probeRef.current = probe;
    void (async () => {
      let probeOk = false;
      let count = 0;
      try {
        count = await probe;
        if (genRef.current !== gen) return;
        setNumPages(count);
        probeOk = true;
        const sample = censusSample(count);
        const chars: number[] = [];
        for (const p of sample) {
          const items = await getVisualTextItems(src.bytes, p);
          chars.push(items.reduce((n, i) => n + i.str.length, 0));
        }
        if (genRef.current !== gen) return;
        setDetected(censusMode(chars));
      } catch (err) {
        if (genRef.current !== gen) return;
        // A PROBE failure kills the panel (unreadable/cap). A census failure
        // after a healthy probe must not: the digital path needs no census —
        // drop only the auto-detect badge (detected stays null → digital
        // default) and let the user convert.
        if (!probeOk) {
          probeRef.current = null;
          setNumPages(0);
          if (err instanceof Pdf2WordPageCapError) {
            setErrorKey('p2w.error_cap');
            setErrorDetail(err.message);
          } else {
            setErrorKey('p2w.error_load');
          }
        }
      }
    })();
  }, [src]);

  const togglePage = useCallback((pageNumber: number) => {
    setSelectedPages((prev) => {
      if (!prev) {
        // First toggle on an all-selected document: every page EXCEPT this one.
        const next = new Set<number>();
        for (let p = 1; p <= numPages; p += 1) if (p !== pageNumber) next.add(p);
        return next;
      }
      const next = new Set(prev);
      if (next.has(pageNumber)) next.delete(pageNumber);
      else next.add(pageNumber);
      return next.size === numPages ? null : next; // all re-selected → back to null
    });
  }, [numPages]);

  /** The AI seam (scan pages): the OCR tool's exact wiring — client per
   * platform, raster one page at a time, native carries the dataUrl (R4.3).
   * `?ai-mock=1` drives the canned engine (the OCR e2e seam, F8). */
  const aiConvertPages = useCallback(
    async (pages: number[]): Promise<string[]> => {
      const mocked = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ai-mock');
      const client: AiRunClient = isTauri()
        ? (sharedNativeClient() as AiRunClient)
        : sharedAiClient({ mock: mocked });
      const bytes = src!.bytes;
      const canvas = document.createElement('canvas');
      const scale = AI_DPI / 72;
      const renderPage = async (page: number): Promise<RasterImageData> => {
        const { renderPageToCanvas } = await import('../../engine/pdfjs');
        await renderPageToCanvas(bytes, page, canvas, scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d context unavailable');
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (isTauri()) {
          const raster = { data: image.data, width: image.width, height: image.height } as RasterImageData & { dataUrl?: string };
          raster.dataUrl = canvas.toDataURL('image/png');
          return raster;
        }
        return { data: image.data, width: image.width, height: image.height };
      };
      await downloadIfNeeded(client, AI_MODEL_ID, (p) => {
        setProgress({
          value: 48,
          label: p.percent != null ? t('p2w.ai_downloading', { percent: Math.round(p.percent) }) : t('p2w.ai_downloading_started'),
        });
      });
      const out = await runAiPages(
        client,
        numPages,
        renderPage,
        {
          onPage: (c, total) => {
            // Scale the AI phase into the 48..95 band (extraction already
            // ends near 48 — the bar must never regress).
            setProgress({
              value: 48 + Math.round((c / Math.max(1, total)) * 47),
              label: t('p2w.ai_running', { current: c, total }),
            });
          },
        },
        { pages: [...pages].sort((a, b) => a - b), shouldContinue: () => !abortRef.current },
      );
      // An aborted run (reset mid-run) must not deliver silently-empty
      // pages for the pages that never ran.
      if (!out.completedAll) throw new Error('aborted');
      return out.results
        .slice()
        .sort((a, b) => a.page - b.page)
        .map((r) => r.text);
    },
    [src, numPages, t],
  );

  const run = useCallback(async () => {
    if (!src) return;
    // The probe gate: never decide on a pending probe (split-tool flake class).
    let count = 0;
    try {
      count = await (probeRef.current ?? pdfEngine.loadPdf(src.bytes).then(({ info }) => info.numPages));
    } catch {
      setErrorKey('p2w.error_load');
      return;
    }
    beginJob('pdf-to-word');
    setBusy(true);
    setErrorKey(null);
    setErrorDetail(null);
    setDone(false);
    setProgress({ value: 5, label: t('p2w.progress_extract') });
    abortRef.current = false;
    try {
      const selection = selectedPages ? [...selectedPages].sort((a, b) => a - b) : undefined;
      // F6 honesty: the AI seam rides ONLY the scan route. A scan page
      // reached on the forced-digital route has no seam → the composer's
      // typed Pdf2WordScanError refuses (never a silent fallback).
      const effMode: 'digital' | 'scan' =
        mode !== 'auto' ? mode : detected === 'scan' ? 'scan' : 'digital';
      // Mixed + auto also rides the seam (scan pages inside convert via AI
      // after the confirm card; digital pages stay on the text layer).
      const seamActive = effMode === 'scan' || (mode === 'auto' && detected === 'mixed');
      const res = await runPdf2Word({
        pageCount: count,
        pages: selection,
        extractPage: (p) => getVisualTextItems(src.bytes, p),
        toDocx: (pages) => pdfEngine.markdownToDocx({ ...pages, title: baseName(src.file.name) }),
        aiConvertPages: seamActive ? aiConvertPages : undefined,
        onProgress: (donePages, total) => {
          setProgress({
            value: Math.round((donePages / total) * 95),
            label: donePages <= total / 2 ? t('p2w.progress_extract') : t('p2w.progress_convert'),
          });
        },
      });
      setProgress({ value: 97, label: t('p2w.progress_docx') });
      const base = baseName(src.file.name);
      // A cancelled Save-As is not a success: the done view must not render
      // for a file that was never written.
      const ok = await deliverBytes(
        res.docx,
        `${base}.docx`,
        'download',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      if (!ok) {
        setProgress(null);
        return;
      }
      setProgress({ value: 100, label: t('p2w.progress_done', { count: res.markdown.length, mode: t(`p2w.mode_${res.mode}`) }) });
      setDone(true);
    } catch (err) {
      if (err instanceof Pdf2WordPageCapError) {
        setErrorKey('p2w.error_cap');
        setErrorDetail(err.message);
      } else if (err instanceof Pdf2WordItemCapError) {
        setErrorKey('p2w.error_items');
        setErrorDetail(err.message);
      } else if (err instanceof Pdf2WordScanError) {
        setErrorKey('p2w.error_scan');
        setErrorDetail(err.message);
      } else {
        setErrorKey('p2w.error_generic');
        setErrorDetail(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
      endJob('pdf-to-word');
    }
  }, [aiConvertPages, detected, mode, selectedPages, src, t]);

  const resetAll = () => {
    abortRef.current = true;
    clear();
    setNumPages(0);
    setDetected(null);
    setMode('auto');
    setSelectedPages(null);
    setScanConfirm(false);
    setSlowTier(false);
    setProgress(null);
    setErrorKey(null);
    setErrorDetail(null);
    setDone(false);
  };

  const effectiveMode: 'digital' | 'scan' = mode !== 'auto' ? mode : detected === 'scan' ? 'scan' : 'digital';
  const base = src ? baseName(src.file.name) : '';

  // F6: choosing the scan route (explicitly, by trusting the census on a
  // scan-detected file, or mixed-with-scan-pages) arms the confirm card —
  // the CTA never silently engages the AI engine or its 652MB download.
  const needsScanConfirm = effectiveMode === 'scan' || (mode === 'auto' && detected === 'mixed');

  const onCta = () => {
    if (!needsScanConfirm || scanConfirm) {
      void run();
      return;
    }
    void (async () => {
      const tier = await aiTierEstimate().catch(() => null);
      setSlowTier(tier?.tier === 'cpu');
      setScanConfirm(true);
    })();
  };

  const error = fileError ?? (errorKey ? t(errorKey) : null);

  return (
    <WorkspaceShell
      title={t('pdf-to-word.title')}
      meta={
        src && numPages > 0
          ? t('meta.file_pages', {
              name: src.file.name,
              count: numPages,
              size: formatBytes(src.file.size, lng === 'vi' ? 'vi-VN' : 'en-US'),
            })
          : undefined
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: src ? 'done' : 'now' },
        { key: 'configure', label: t('steps.configure'), state: src ? 'now' : 'todo' },
        { key: 'download', label: t('steps.download'), state: done ? 'done' : 'todo' },
      ]}
      error={errorDetail ? `${error} — ${errorDetail}` : error}
      side={
        src && numPages > 0 ? (
          <>
            <fieldset>
              <legend className="text-sm font-bold">{t('p2w.mode_q')}</legend>
              <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label={t('p2w.mode_q')}>
                {(['digital', 'scan'] as const).map((m) => (
                  <label
                    key={m}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
                      effectiveMode === m ? 'border-accent bg-surface-card' : 'border-border-strong bg-surface-card'
                    }`}
                  >
                    <input
                      type="radio"
                      name="p2w-mode"
                      value={m}
                      checked={effectiveMode === m}
                      onChange={() => {
                        setMode(m);
                        setScanConfirm(false);
                      }}
                      className="mt-1 h-4 w-4 accent-accent"
                    />
                    <span>
                      <span className="block font-semibold">
                        {t(`p2w.mode_${m}`)}
                        {detected !== null && detected !== 'mixed' && detected === m ? (
                          <span className="ml-2 rounded bg-tone-green-soft px-1.5 py-0.5 text-[11px] font-bold text-tone-green">
                            {t('p2w.detected_badge')}
                          </span>
                        ) : null}
                      </span>
                      <span className="block text-xs text-text-muted">{t(`p2w.mode_${m}_hint`)}</span>
                    </span>
                  </label>
                ))}
              </div>
              {detected === 'mixed' ? (
                <p className="mt-1.5 text-xs text-text-muted">{t('p2w.detected_mixed_note')}</p>
              ) : null}
            </fieldset>
            <Hint variant="info" dismissKey="hint-pdf-to-word-honesty">
              {t('p2w.honesty')}
            </Hint>
            {numPages > 1 && thumbPages.length > 0 ? (
              <ThumbnailStrip
                pages={thumbPages}
                fullscreenTitle={(n) => t('a11y.page_n', { n })}
                closeLabel={t('a11y.close')}
                onToggle={togglePage}
                register={thumbObserve}
              />
            ) : null}
            {scanConfirm ? (
              <div className="rounded-lg border border-border-strong bg-surface-card p-3.5 text-sm" data-testid="p2w-scan-confirm">
                <p className="font-bold">{t('p2w.ai_confirm_title')}</p>
                <p className="mt-1 text-xs text-text-muted">{t('p2w.ai_confirm_body')}</p>
                {slowTier ? <p className="mt-1 text-xs font-semibold text-tone-orange">{t('p2w.ai_slow_warn')}</p> : null}
                <div className="mt-2.5 flex gap-2">
                  <Button onClick={() => void run()} disabled={busy}>
                    {t('p2w.ai_confirm_cta')}
                  </Button>
                  <Button variant="secondary" onClick={() => setScanConfirm(false)} disabled={busy}>
                    {t('p2w.ai_cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                onClick={onCta}
                disabled={busy || (selectedPages !== null && selectedPages.size === 0)}
              >
                {t('p2w.cta')}
              </Button>
            )}
            {progress ? null : (
              <span className="text-[13px] text-text-muted">{t('p2w.progress_idle', { base })}</span>
            )}
          </>
        ) : null
      }
      progress={progress}
      onReset={resetAll}
    >
      <Dropzone
        title={t('pdf-to-word.dropzone_title')}
        hint={t('pdf-to-word.dropzone_hint')}
        accept="application/pdf,.pdf"
        multiple={false}
        // Single-file tool: a second drop REPLACES (clear + re-add); without
        // this the new file appends behind files[0] and silently does nothing.
        onFiles={(f) => {
          clear();
          void add(f.slice(0, 1));
        }}
      />
    </WorkspaceShell>
  );
}

function baseName(fileName: string): string {
  const stripped = fileName.replace(/\.pdf$/i, '').trim();
  return stripped === '' ? 'pdf' : stripped;
}
