import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { takePendingFiles } from '../../lib/handoff';
import { getPageCount, getVisualTextItems, getPageVisualSize } from '../../engine/pdfjs';
import { COMPARE_PAGE_CAP, CompareCapError, CompareCancelled, WordLru, runCompare } from '../../lib/pdf-compare';
import type { CompareResult, PagePair } from '../../lib/pdf-compare';
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
 * navigator lists B's pages with changed-dot badges. NO export UI in this
 * phase (P8 adds the annotated-export buttons).
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
  const [result, setResult] = useState<CompareResult | null>(null);
  const [pairIdx, setPairIdx] = useState(0);
  const [viewSide, setViewSide] = useState<'a' | 'b'>('b');

  const genRef = useRef(0);
  const runningRef = useRef(false);

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
    setBusy(false);
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
  };

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

