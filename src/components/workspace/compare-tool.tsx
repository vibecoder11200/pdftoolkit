import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { takePendingFiles } from '../../lib/handoff';
import { getPageCount, getVisualTextItems, getPageVisualSize, renderPageToCanvas } from '../../engine/pdfjs';
import {
  COMPARE_PAGE_CAP,
  CompareCapError,
  CompareCancelled,
  WordLru,
  coalesceCompareMarks,
  runCompare,
  textDiffClauses,
} from '../../lib/pdf-compare';
import type { CompareMark, CompareResult, PagePair } from '../../lib/pdf-compare';
import { engine } from '../../engine/client';
import { deliverBytesMulti } from '../../lib/download';
import { aiTierEstimate, downloadIfNeeded, runAiPages, type AiRunClient } from '../../lib/ai-run';
import { AI_MODEL_ID } from '../../lib/ai-models';
import { sharedAiClient } from '../../lib/ai-worker-client';
import { sharedNativeClient } from '../../lib/ai-native-client';
import { isTauri } from '../../lib/platform';
import type { RasterImageData } from '../../workers/pdf.worker';
import { engineErrorDetail } from '../../lib/engine-error';
import { type ErrorDetail } from '../ui/error-banner';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { Hint } from '../ui/hint';
import { WorkspaceShell } from './workspace-shell';
import { ThumbnailStrip } from './thumbnail-strip';
import { ReadOnlyPageCanvas } from './editor-canvas';
import { useThumbnails } from '../../hooks/use-thumbnails';

/*
 * Compare PDFs (tool #19, v0.11.0 phase 7, plan 261109-1101). Two file
 * slots (A = original, B = revised) stream through runCompare: per-page
 * extraction through doc-token LRU caches, page-LCS alignment, word-level
 * diff. The viewer renders ONE pair at a time through the shared read-only
 * canvas (green inserted boxes on B / red strikethrough boxes on A); the
 * navigator lists B's pages with changed-dot badges. P8 adds the annotated
 * export (annotateCompare over both docs, deliverBytesMulti) and the
 * AI-OCR scan leg (census → confirm card → textDiff clause panel).
 *
 * Chip semantics: acceptsPdf makes compare a chip DESTINATION (pending
 * files fill slot A at mount); B stays manual with honest copy (no
 * two-slot chip precedent). NO ContinueChip host in this cycle (host
 * enumeration frozen at 13).
 */

/** Combined-bytes gate (red-team F6): an honest raster/OCR pressure
 * expectation above it — never a silent cap beyond the page cap. */
const COMPARE_BYTES_GATE = 150 * 1024 * 1024;

interface CompareSlot {
  file: File;
  bytes: Uint8Array;
  /** Bound to THIS document — swaps exchange whole slots so caches stay
   * valid per doc; a new drop replaces the slot (and its cache). */
  cache: WordLru;
}

async function makeSlot(file: File): Promise<CompareSlot> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { file, bytes, cache: new WordLru() };
}

/** A pair carries visible changes: any word-diff marks or a wholesale bail. */
const pairHasDiff = (p: PagePair): boolean =>
  p.inserted.length > 0 || p.removed.length > 0 || p.wholesale !== undefined;

/** e2e mock seam (F8, OCR precedent): `?ai-mock=1` drives the canned engine. */
const isAiMock = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ai-mock');

const baseName = (fileName: string): string => fileName.replace(/\.pdf$/i, '');

/** AI raster DPI for scan pairs — the pdf-to-word AI seam value (the worker
 * caps the long edge anyway). */
const COMPARE_AI_DPI = 150;

/** Scan census floor — pdf2word's PDF2WORD_CENSUS_MIN_CHARS by VALUE
 * (cited, not imported: pdf2word is a heavy module and a one-constant
 * import would drag its pipeline into the compare chunk). */
const COMPARE_CENSUS_MIN_CHARS = 32;

/** Pairs whose word marks feed the annotated export (scan pairs excluded —
 * their textDiff has no positions, so there is nothing honest to draw). */
function exportMarks(result: CompareResult, scanPairIdxs: Set<number>): { del: CompareMark[]; ins: CompareMark[]; scanCount: number } {
  const del: CompareMark[] = [];
  const ins: CompareMark[] = [];
  let scanCount = 0;
  result.pairs.forEach((p, i) => {
    if (p.oldPage <= 0 || p.newPage === null) return;
    if (scanPairIdxs.has(i)) {
      scanCount += 1;
      return;
    }
    for (const w of p.removed) del.push({ page: p.oldPage, nx: w.nx, nyTop: w.ny, nw: w.nw, nh: w.nh, kind: 'del' });
    for (const w of p.inserted) ins.push({ page: p.newPage, nx: w.nx, nyTop: w.ny, nw: w.nw, nh: w.nh, kind: 'ins' });
  });
  // Coalesce HERE too (display + payload hygiene); the engine op re-runs it
  // defensively regardless (budget is checked on the raw count there).
  return { del: coalesceCompareMarks(del), ins: coalesceCompareMarks(ins), scanCount };
}

export function CompareTool() {
  const { t } = useTranslation(['common', 'tools']);

  const [slotA, setSlotA] = useState<CompareSlot | null>(null);
  const [slotB, setSlotB] = useState<CompareSlot | null>(null);
  const [countA, setCountA] = useState(0);
  const [countB, setCountB] = useState(0);
  const [probeError, setProbeError] = useState<string | ErrorDetail | null>(null);
  const [bigGate, setBigGate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [error, setError] = useState<string | ErrorDetail | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [pairIdx, setPairIdx] = useState(0);
  const [viewSide, setViewSide] = useState<'a' | 'b'>('b');
  // P8: annotated export + AI-OCR scan leg.
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [scanChars, setScanChars] = useState<{ a: number[]; b: number[] } | null>(null);
  const [slowTier, setSlowTier] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDeclined, setAiDeclined] = useState(false);
  const [textDiffs, setTextDiffs] = useState<Map<number, { added: string[]; removed: string[] }>>(new Map());

  const genRef = useRef(0);
  const runningRef = useRef(false);
  /** The last SUCCESSFULLY probed (slot pair + counts). The census gates on
   * it: during a swap commit the effect pass still sees the OLD result with
   * the NEW slots — probing against that mismatch would extract pages the
   * freshly-swapped caches don't hold (wasted work, the swap-identity
   * spec caught it). */
  const probedRef = useRef<{ a: CompareSlot | null; b: CompareSlot | null; ca: number; cb: number } | null>(null);

  const probePending = Boolean((slotA && countA === 0) || (slotB && countB === 0));

  // Home-sheet handoff: one-shot take fills slot A only (B is manual —
  // the honest copy under slot B's dropzone says so; no two-slot precedent).
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void makeSlot(taken.files[0]).then(setSlotA);
  }, []);

  // Probe page counts via main-thread pdf.js getPageCount (shared docCache
  // — NOT engine.loadPdf, which would double-load both docs into a worker
  // that never uses them; red-team F6). BOTH probes are awaited before the
  // CTA decides anything (the split-probe flake class).
  useEffect(() => {
    const gen = (genRef.current += 1);
    setProbeError(null);
    setResult(null);
    setPairIdx(0);
    setProgress(null);
    setError(null);
    setCancelled(false);
    setBusy(false);
    setScanChars(null);
    setTextDiffs(new Map());
    setAiDeclined(false);
    setExportNote(null);
    if (slotA) setCountA(0);
    if (slotB) setCountB(0);
    setBigGate(Boolean(slotA && slotB && slotA.file.size + slotB.file.size > COMPARE_BYTES_GATE));
    if (!slotA && !slotB) return;
    void (async () => {
      try {
        const [a, b] = await Promise.all([
          slotA ? getPageCount(slotA.bytes) : Promise.resolve(0),
          slotB ? getPageCount(slotB.bytes) : Promise.resolve(0),
        ]);
        if (genRef.current !== gen) return;
        setCountA(a);
        setCountB(b);
        probedRef.current = { a: slotA, b: slotB, ca: a, cb: b };
        // a/b are 0 for an absent slot — the cap check needs no re-test.
        if (a > COMPARE_PAGE_CAP || b > COMPARE_PAGE_CAP) {
          setProbeError(t('compare.err_cap', { cap: COMPARE_PAGE_CAP }));
        }
      } catch (e) {
        if (genRef.current !== gen) return;
        setProbeError(
          engineErrorDetail(e, t('compare.err_load'), crashCopy(t), () => {
            if (slotA) void makeSlot(slotA.file).then(setSlotA);
            if (slotB) void makeSlot(slotB.file).then(setSlotB);
          }),
        );
      }
    })();
  }, [slotA, slotB, t]);

  const swap = () => {
    // Swap-by-REFERENCE (red-team F5): whole slot objects exchange places —
    // each doc's CompWord cache travels WITH its document, so a swap →
    // re-run costs zero re-extraction and can never mislabel a page.
    setSlotA(slotB);
    setSlotB(slotA);
  };

  const run = useCallback(async () => {
    if (!slotA || !slotB || busy) return;
    const genAtStart = genRef.current;
    runningRef.current = true;
    setBusy(true);
    setError(null);
    setCancelled(false);
    setResult(null);
    setPairIdx(0);
    setProgress({ value: 4, label: t('compare.progress_start') });
    const bytesOf = (doc: 'a' | 'b') => (doc === 'a' ? slotA : slotB).bytes;
    try {
      const res = await runCompare({
        pageCountA: countA,
        pageCountB: countB,
        getItems: (doc, page) => getVisualTextItems(bytesOf(doc), page),
        getSize: (doc, page) => getPageVisualSize(bytesOf(doc), page),
        cacheA: slotA.cache,
        cacheB: slotB.cache,
        onProgress: (done, total) => {
          if (genRef.current !== genAtStart) return;
          setProgress({
            value: 4 + Math.round((done / Math.max(1, total)) * 92),
            label: t('compare.progress_pages', { done, total }),
          });
        },
        shouldContinue: () => genRef.current === genAtStart,
      });
      if (genRef.current !== genAtStart) return;
      setResult(res);
      const firstChanged = res.pairs.findIndex(pairHasDiff);
      setPairIdx(firstChanged >= 0 ? firstChanged : 0);
      setProgress({ value: 100, label: t('compare.progress_done', res.stats) });
    } catch (e) {
      if (genRef.current !== genAtStart) return;
      if (e instanceof CompareCancelled) return; // cancelled/stale: silent
      if (e instanceof CompareCapError) {
        setProbeError(e.message);
        return;
      }
      setError(engineErrorDetail(e, t('compare.err_generic'), crashCopy(t), () => void run()));
    } finally {
      runningRef.current = false;
      setBusy(false);
    }
  }, [slotA, slotB, countA, countB, busy, t]);

  const cancel = () => {
    genRef.current += 1; // flips shouldContinue → CompareCancelled → silent stop
    setBusy(false);
    setProgress(null);
    setCancelled(true); // UX audit F3: a silent return to intake read as "did it even stop?"
  };

  // ── P8: scan census + AI-OCR leg + annotated export ──
  // Census (8b): per-page char counts on BOTH docs after a run; a pair is
  // scan-class when EITHER side is scan-class (pdf2word census rule).
  useEffect(() => {
    const probed = probedRef.current;
    const consistent = Boolean(
      probed && probed.a === slotA && probed.b === slotB && probed.ca === countA && probed.cb === countB,
    );
    if (!result || !slotA || !slotB || !consistent) {
      setScanChars(null);
      return;
    }
    const gen = genRef.current;
    void (async () => {
      try {
        // Cache-first: the run's WordLru already holds CompWords for docs
        // up to 32 pages — census char counts derive from those (word
        // chars, whitespace excluded — never decisive at the 32-char
        // floor) and cost zero extraction. LRU evictions re-extract.
        const charCount = async (slot: CompareSlot, pages: number): Promise<number[] | null> => {
          const out: number[] = [];
          for (let p = 1; p <= pages; p += 1) {
            if (genRef.current !== gen) return null;
            const cached = slot.cache.get(p);
            if (cached) {
              out.push(cached.reduce((sum, w) => sum + w.text.length, 0));
              continue;
            }
            const items = await getVisualTextItems(slot.bytes, p);
            out.push(items.reduce((sum, it) => sum + it.str.length, 0));
          }
          return out;
        };
        const a = await charCount(slotA, countA);
        const b = a ? await charCount(slotB, countB) : null;
        if (genRef.current !== gen || !a || !b) return;
        setScanChars({ a, b });
      } catch {
        if (genRef.current === gen) setScanChars(null);
      }
    })();
  }, [result, slotA, slotB, countA, countB]);

  const scanPairIdxs = new Set<number>();
  if (result && scanChars) {
    result.pairs.forEach((p, i) => {
      if (p.oldPage <= 0 || p.newPage === null) return;
      const aScan = (scanChars.a[p.oldPage - 1] ?? Number.MAX_SAFE_INTEGER) < COMPARE_CENSUS_MIN_CHARS;
      const bScan = (scanChars.b[p.newPage - 1] ?? Number.MAX_SAFE_INTEGER) < COMPARE_CENSUS_MIN_CHARS;
      if (aScan || bScan) scanPairIdxs.add(i);
    });
  }
  const aiDone = textDiffs.size > 0;
  const aiCardVisible = Boolean(result && scanChars && scanPairIdxs.size > 0 && !aiDone && !aiDeclined);
  // Slow-tier warning resolves AT ARM TIME so it is visible before the
  // user commits (pdf-to-word onCta pattern).
  useEffect(() => {
    if (!aiCardVisible) return;
    void aiTierEstimate()
      .then((tier) => setSlowTier(tier?.tier === 'cpu'))
      .catch(() => {});
  }, [aiCardVisible]);

  // Confirm → raster + OCR the scan pages of BOTH docs (sequential docs,
  // one page at a time RAM rule), then text-diff each scan pair through
  // textDiffClauses (the lcsTokens wrapper — C6). Cancel = genRef flip.
  const runAiScanLeg = useCallback(async () => {
    if (!result || !slotA || !slotB || !scanChars || aiBusy) return;
    const genAtStart = genRef.current;
    setAiBusy(true);
    setError(null);
    try {
      const client: AiRunClient = isTauri() ? (sharedNativeClient() as AiRunClient) : sharedAiClient({ mock: isAiMock() });
      const canvas = document.createElement('canvas');
      const scale = COMPARE_AI_DPI / 72;
      const renderFor = (bytes: Uint8Array) => async (page: number): Promise<RasterImageData> => {
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
      await downloadIfNeeded(client, AI_MODEL_ID, (prog) => {
        if (genRef.current !== genAtStart) return;
        setProgress({
          value: prog.percent != null ? Math.round(prog.percent) : 10,
          label: t('compare.ai_downloading'),
        });
      });
      const ocrDoc = async (bytes: Uint8Array, pageCount: number, pages: number[]): Promise<Map<number, string>> => {
        const map = new Map<number, string>();
        if (pages.length === 0) return map;
        const out = await runAiPages(
          client,
          pageCount,
          renderFor(bytes),
          {
            onPage: (c, total) => {
              if (genRef.current !== genAtStart) return;
              setProgress({
                value: 10 + Math.round((c / Math.max(1, total)) * 85),
                label: t('compare.ai_running', { current: c, total }),
              });
            },
          },
          { pages: [...pages].sort((x, y) => x - y), shouldContinue: () => genRef.current === genAtStart },
        );
        for (const r of out.results) map.set(r.page, r.text);
        return map;
      };
      const aPages = [...scanPairIdxs].map((i) => result.pairs[i]!.oldPage).filter((n) => n > 0);
      const bPages = [...scanPairIdxs].map((i) => result.pairs[i]!.newPage).filter((n): n is number => n !== null);
      const textsA = await ocrDoc(slotA.bytes, countA, [...new Set(aPages)]);
      const textsB = await ocrDoc(slotB.bytes, countB, [...new Set(bPages)]);
      if (genRef.current !== genAtStart) return;
      const diffs = new Map<number, { added: string[]; removed: string[] }>();
      for (const i of scanPairIdxs) {
        const p = result.pairs[i]!;
        if (p.oldPage <= 0 || p.newPage === null) continue;
        diffs.set(i, textDiffClauses(textsA.get(p.oldPage) ?? '', textsB.get(p.newPage) ?? ''));
      }
      setTextDiffs(diffs);
      setProgress(null);
    } catch (e) {
      if (genRef.current !== genAtStart) return;
      if (e instanceof CompareCancelled) return;
      setError(engineErrorDetail(e, t('compare.err_generic'), crashCopy(t), () => void runAiScanLeg()));
    } finally {
      setAiBusy(false);
    }
  }, [result, slotA, slotB, scanChars, countA, countB, aiBusy, t]);

  // Annotated export (8a): overlay marks (scan pairs excluded + counted)
  // through the engine op, then deliverBytesMulti — ONE desktop Save-As
  // dialog, siblings beside.
  const runExport = useCallback(async () => {
    if (!result || !slotA || !slotB || exporting) return;
    setExporting(true);
    setError(null);
    setExportNote(null);
    try {
      const { del, ins, scanCount } = exportMarks(result, scanPairIdxs);
      const aOut = await engine.annotateCompare(slotA.bytes, del);
      const bOut = await engine.annotateCompare(slotB.bytes, ins);
      const stemA = baseName(slotA.file.name);
      const stemB = baseName(slotB.file.name);
      await deliverBytesMulti([
        { bytes: aOut, filename: `${stemA}-so-sanh-A.pdf` },
        { bytes: bOut, filename: `${stemB}-so-sanh-B.pdf` },
      ]);
      setExportNote(scanCount > 0 ? t('compare.scan_excluded', { n: scanCount }) : null);
    } catch (e) {
      setError(engineErrorDetail(e, t('compare.err_export'), crashCopy(t), () => void runExport()));
    } finally {
      setExporting(false);
    }
  }, [result, slotA, slotB, exporting, t, scanPairIdxs]);

  // Derived view state. The A/B preference coerces per pair: an added-only
  // pair (oldPage 0) has no A page and a removed-only pair (newPage null)
  // has no B page — rendering the other side would paint page 0 or show an
  // unmarked wrong page.
  const pair: PagePair | null = result?.pairs[pairIdx] ?? null;
  const viewSideEff: 'a' | 'b' = pair
    ? pair.oldPage === 0
      ? 'b'
      : pair.newPage === null
        ? 'a'
        : viewSide
    : 'b';
  const viewSlot = viewSideEff === 'a' ? slotA : slotB;
  const viewPage = pair ? (viewSideEff === 'a' ? pair.oldPage : (pair.newPage ?? 1)) : 1;
  // Clause panel data for the selected scan pair (undefined = not a scan
  // pair, or the AI leg has not run).
  const pairTextDiff = scanPairIdxs.has(pairIdx) ? textDiffs.get(pairIdx) : undefined;
  const changedBPages = new Map<number, 'changed' | 'added'>();
  if (result) {
    for (const p of result.pairs) {
      if (p.oldPage > 0 && p.newPage !== null && pairHasDiff(p)) {
        changedBPages.set(p.newPage, 'changed');
      }
    }
    for (const n of result.addedPages) changedBPages.set(n, 'added');
  }

  const { urlFor: thumbUrlFor, observe: thumbObserve } = useThumbnails(
    result && slotB && countB > 1
      ? Array.from({ length: countB }, (_, i) => ({ id: `cmp-b-${i + 1}`, bytes: slotB.bytes, page: i + 1 }))
      : [],
  );

  const ready = Boolean(slotA && slotB && countA > 0 && countB > 0 && !probePending && !probeError && !busy);

  return (
    <WorkspaceShell
      title={t('compare.title')}
      meta={
        slotA && slotB && countA > 0 && countB > 0
          ? t('compare.meta', { a: slotA.file.name, b: slotB.file.name, na: countA, nb: countB })
          : undefined
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: slotA && slotB ? 'done' : 'now' },
        { key: 'run', label: t('compare.step_run'), state: result ? 'done' : slotA && slotB ? 'now' : 'todo' },
        { key: 'review', label: t('compare.step_review'), state: result ? 'now' : 'todo' },
      ]}
      error={error ?? probeError ?? null}
      progress={busy ? progress : null}
      side={
        <>
          <Hint variant="info" dismissKey="hint-compare-honesty">
            {t('compare.honest')}
          </Hint>
          <p className="text-[12.5px] leading-relaxed text-text-muted">{t('compare.side_note')}</p>
        </>
      }
      onReset={() => {
        genRef.current += 1;
        setSlotA(null);
        setSlotB(null);
        setCountA(0);
        setCountB(0);
        setProbeError(null);
        setResult(null);
        setPairIdx(0);
        setProgress(null);
        setError(null);
        setBigGate(false);
        setScanChars(null);
        setTextDiffs(new Map());
        setAiDeclined(false);
        setExporting(false);
        setExportNote(null);
        setCancelled(false);
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <SlotPicker
          slot={slotA}
          label={t('compare.slot_a')}
          title={t('compare.drop_a_title')}
          hint={t('compare.drop_a_hint')}
          onFile={(f) => void makeSlot(f).then(setSlotA)}
          onClear={() => setSlotA(null)}
        />
        <SlotPicker
          slot={slotB}
          label={t('compare.slot_b')}
          title={t('compare.drop_b_title')}
          hint={t('compare.drop_b_hint')}
          onFile={(f) => void makeSlot(f).then(setSlotB)}
          onClear={() => setSlotB(null)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={swap} disabled={busy || (!slotA && !slotB)}>
          {t('compare.swap')}
        </Button>
        {cancelled ? (
          <p className="rounded-lg border border-border-strong bg-surface-card p-2.5 text-[13px]">
            {t('compare.cancelled_note')}
          </p>
        ) : null}
        {bigGate ? <span className="text-[13px] text-text-muted">{t('compare.big_gate')}</span> : null}
      </div>
      {busy ? (
        <Button variant="secondary" onClick={cancel}>
          {t('compare.cancel')}
        </Button>
      ) : (
        <Button onClick={() => void run()} disabled={!ready}>
          {t('compare.cta')}
        </Button>
      )}
      {!busy && progress ? <span className="text-[13px] text-text-muted">{progress.label}</span> : null}

      {result ? (
        <div className="flex flex-col gap-3" data-testid="compare-result">
          {result.unaligned ? (
            <p className="rounded-lg border border-border-strong bg-surface-card p-2.5 text-[13px]">
              {t('compare.unaligned_notice')}
            </p>
          ) : null}
          {result.addedPages.length > 0 ? (
            <p className="rounded-lg border border-tone-green/40 bg-tone-green-soft p-2.5 text-[13px] font-semibold text-tone-green">
              {t('compare.added_banner', { pages: result.addedPages.join(', ') })}
            </p>
          ) : null}
          {result.removedPages.length > 0 ? (
            <p className="rounded-lg border border-tone-red/40 bg-tone-red-soft p-2.5 text-[13px] font-semibold text-tone-red">
              {t('compare.removed_banner', { pages: result.removedPages.join(', ') })}
            </p>
          ) : null}
          <p className="text-[13px] text-text-muted">{t('compare.stats', result.stats)}</p>

          {countB > 1 ? (
            <ThumbnailStrip
              pages={Array.from({ length: countB }, (_, i) => ({
                key: `cmp-b-${i + 1}`,
                pageNumber: i + 1,
                url: thumbUrlFor(`cmp-b-${i + 1}`),
                selected: pair?.newPage === i + 1,
              }))}
              fullscreenTitle={(n) => t('a11y.page_n', { n })}
              closeLabel={t('a11y.close')}
              onToggle={(n) => {
                const idx = result.pairs.findIndex((p) => p.newPage === n);
                if (idx >= 0) setPairIdx(idx);
              }}
              selectable={false}
              tileBadge={(n) =>
                changedBPages.has(n) ? (
                  <span
                    className={`inline-block rounded-md px-1.75 py-0.5 text-[11px] font-bold ${
                      changedBPages.get(n) === 'added'
                        ? 'bg-tone-green-soft text-tone-green'
                        : 'bg-tone-orange-soft text-tone-orange'
                    }`}
                  >
                        {changedBPages.get(n) === 'added' ? t('compare.badge_added') : t('compare.badge_changed')}
                      </span>
                    ) : null
                  }
              register={thumbObserve}
            />
          ) : null}

          {pair ? (
            <div className="flex flex-col gap-2" data-testid="compare-viewer">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold">
                  {t('compare.pair_label', { page: pair.newPage ?? pair.oldPage })}
                </span>
                {pair.oldPage > 0 && pair.newPage !== null ? (
                  <span className="flex gap-1" role="group" aria-label={t('compare.view_toggle')}>
                    <button
                      type="button"
                      aria-pressed={viewSideEff === 'a'}
                      onClick={() => setViewSide('a')}
                      className={`min-h-8 rounded-md border px-2.5 text-[12.5px] font-semibold ${
                        viewSideEff === 'a' ? 'border-accent bg-accent-soft' : 'border-border-strong text-text-muted'
                      }`}
                    >
                      {t('compare.view_a')}
                    </button>
                    <button
                      type="button"
                      aria-pressed={viewSideEff === 'b'}
                      onClick={() => setViewSide('b')}
                      className={`min-h-8 rounded-md border px-2.5 text-[12.5px] font-semibold ${
                        viewSideEff === 'b' ? 'border-accent bg-accent-soft' : 'border-border-strong text-text-muted'
                      }`}
                    >
                      {t('compare.view_b')}
                    </button>
                  </span>
                ) : null}
                <span className="flex gap-1">
                  <Button variant="secondary" onClick={() => setPairIdx((i) => Math.max(0, i - 1))} disabled={pairIdx === 0}>
                    ←
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setPairIdx((i) => Math.min(result.pairs.length - 1, i + 1))}
                    disabled={pairIdx >= result.pairs.length - 1}
                  >
                    →
                  </Button>
                </span>
              </div>
              {pair.wholesale ? (
                <div className="rounded-lg border border-border-strong bg-surface-card p-3 text-[13px]" data-testid="compare-wholesale">
                  <p className="font-bold">{t('compare.wholesale_title')}</p>
                  <p className="mt-1 whitespace-pre-wrap text-text-muted">{pair.wholesale.oldText}</p>
                  <p className="mt-2 whitespace-pre-wrap text-text-muted">{pair.wholesale.newText}</p>
                </div>
              ) : pairTextDiff ? (
                <div className="rounded-lg border border-border-strong bg-surface-card p-3 text-[13px]" data-testid="compare-scan-panel">
                  <p className="font-bold">
                    <span className="mr-1.5 inline-block rounded-md bg-tone-purple-soft px-1.75 py-0.5 text-[11px] font-bold text-tone-purple">
                      {t('compare.scan_badge')}
                    </span>
                    {t('compare.pair_label', { page: pair.newPage ?? pair.oldPage })}
                  </p>
                  {pairTextDiff.removed.length > 0 ? (
                    <div className="mt-2">
                      <p className="font-semibold text-tone-red">{t('compare.clause_removed')}</p>
                      <ul className="mt-1 list-disc pl-5">
                        {pairTextDiff.removed.map((cl, i) => (
                          <li key={`rm-${i}`} className="whitespace-pre-wrap">{cl}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {pairTextDiff.added.length > 0 ? (
                    <div className="mt-2">
                      <p className="font-semibold text-tone-green">{t('compare.clause_added')}</p>
                      <ul className="mt-1 list-disc pl-5">
                        {pairTextDiff.added.map((cl, i) => (
                          <li key={`ad-${i}`} className="whitespace-pre-wrap">{cl}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {pairTextDiff.removed.length === 0 && pairTextDiff.added.length === 0 ? (
                    <p className="mt-2 text-text-muted">{t('compare.clause_same')}</p>
                  ) : null}
                </div>
              ) : (
                viewSlot && (
                  <ReadOnlyPageCanvas
                    bytes={viewSlot.bytes}
                    page={viewPage}
                    version={`${viewSide}-${viewPage}`}
                    testid="compare-canvas"
                  >
                    {viewSideEff === 'b'
                      ? pair.inserted.map((w, i) => (
                          <div
                            key={`ins-${i}`}
                            data-testid="compare-ins-mark"
                            className="pointer-events-none absolute border border-green-600/70 bg-green-500/30"
                            style={{
                              left: `${w.nx * 100}%`,
                              top: `${w.ny * 100}%`,
                              width: `${w.nw * 100}%`,
                              height: `${w.nh * 100}%`,
                            }}
                          />
                        ))
                      : pair.removed.map((w, i) => (
                          <div
                            key={`del-${i}`}
                            data-testid="compare-del-mark"
                            className="pointer-events-none absolute border border-red-600/70 bg-red-500/20"
                            style={{
                              left: `${w.nx * 100}%`,
                              top: `${w.ny * 100}%`,
                              width: `${w.nw * 100}%`,
                              height: `${Math.max(0.012, w.nh * 0.12) * 100}%`,
                              marginTop: `${w.nh * 0.44 * 100}%`,
                            }}
                          />
                        ))}
                  </ReadOnlyPageCanvas>
                )
              )}
              <div className="flex gap-4 text-[12.5px] text-text-muted">
                <span>
                  <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-green-500/60" aria-hidden />
                  {t('compare.ins_legend', { count: pair.inserted.length })}
                </span>
                <span>
                  <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-red-500/60" aria-hidden />
                  {t('compare.del_legend', { count: pair.removed.length })}
                </span>
              </div>
            </div>
          ) : null}

          {aiCardVisible && slotA && slotB ? (
            <div className="rounded-lg border border-tone-purple/40 bg-tone-purple-soft p-3 text-[13px]" data-testid="compare-ai-confirm">
              <p className="font-bold">{t('compare.ai_confirm_title', { n: scanPairIdxs.size })}</p>
              <p className="mt-1 text-text-muted">{t('compare.ai_confirm_body', { n: scanPairIdxs.size })}</p>
              {slowTier ? <p className="mt-1 font-semibold text-tone-orange">{t('compare.ai_slow')}</p> : null}
              <div className="mt-2 flex gap-2">
                <Button onClick={() => void runAiScanLeg()} disabled={aiBusy}>
                  {t('compare.ai_confirm_cta')}
                </Button>
                <Button variant="secondary" onClick={() => setAiDeclined(true)} disabled={aiBusy}>
                  {t('compare.ai_confirm_decline')}
                </Button>
              </div>
            </div>
          ) : null}
          {aiBusy ? (
            <p className="text-[13px] text-text-muted">{progress ? progress.label : t('compare.ai_running', { current: 0, total: 0 })}</p>
          ) : null}
          {aiDeclined ? <p className="text-[13px] text-text-muted">{t('compare.ai_declined')}</p> : null}

          {slotA && slotB && result ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void runExport()} disabled={exporting || busy || aiBusy}>
                {exporting ? t('compare.export_busy') : t('compare.export_cta')}
              </Button>
              {exportNote ? <span className="text-[13px] text-text-muted">{exportNote}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </WorkspaceShell>
  );
}

function crashCopy(t: (k: string) => string): { title: string; detail: string } {
  return { title: t('compare.err_crashed'), detail: t('compare.err_crashed_detail') };
}

function SlotPicker({
  slot,
  label,
  title,
  hint,
  onFile,
  onClear,
}: {
  slot: CompareSlot | null;
  label: string;
  title: string;
  hint: string;
  onFile: (f: File) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-bold text-text-muted">{label}</span>
      {slot ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border-default bg-surface-card px-3 py-2 text-sm">
          <span className="truncate font-semibold">{slot.file.name}</span>
          <span className="shrink-0 text-[12px] text-text-muted tabular-nums">{formatBytes(slot.file.size)}</span>
          <button type="button" onClick={onClear} className="min-h-8 px-2 text-text-muted hover:text-text-primary" aria-label="×">
            ×
          </button>
        </div>
      ) : (
        <Dropzone title={title} hint={hint} accept="application/pdf,.pdf" multiple={false} onFiles={(f) => f[0] && onFile(f[0])} />
      )}
    </div>
  );
}
