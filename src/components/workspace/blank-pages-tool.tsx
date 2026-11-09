import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { takePendingFiles } from '../../lib/handoff';
import { getPageCount, getVisualTextItems, renderPageToCanvas } from '../../engine/pdfjs';
import { getPageVisualSize } from '../../engine/pdfjs';
import { engine } from '../../engine/client';
import { COMPARE_PAGE_CAP } from '../../lib/pdf-compare';
import { analyzeInk, blankRasterScale, classifyBlank, BLANK_INK_MAX, BLANK_STDDEV_MAX } from '../../lib/blank-page';
import type { BlankVerdict } from '../../lib/blank-page';
import { engineErrorDetail } from '../../lib/engine-error';
import { type ErrorDetail } from '../ui/error-banner';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { Hint } from '../ui/hint';
import { WorkspaceShell } from './workspace-shell';
import { ThumbnailStrip } from './thumbnail-strip';
import { useThumbnails } from '../../hooks/use-thumbnails';
import { deliverBytes } from '../../lib/download';

/*
 * Blank-page removal (tool #20, v0.11.0 phase 9, plan 261109-1101).
 * Detect → review → remove: pages stream through the digital fast path
 * (text layer non-empty ⇒ content, no render) then the raster dual
 * criteria (ink ≤ 0.5% AND stddev ≤ 5 @ clamped ~30 DPI grey); 'blank'
 * pages auto-check, 'near' and 'unknown' NEVER do (S3 fail-closed: a
 * clamped zero-ink raster is 'unknown', not blank — a failed canvas
 * allocation can never delete real content). Removal is the ONLY engine
 * mutation (removePages — no new op) and delivers one PDF.
 *
 * Chip semantics: acceptsPdf = chip DESTINATION; NOT a ContinueChip host
 * (the host enumeration stays frozen at 13).
 */

interface Verdict {
  page: number;
  verdict: BlankVerdict;
  /** Ink fraction as measured (display: percentage). */
  ink: number;
}

/** The module's OWN canvas — never shared (v0.7.0 nothing-retained rule). */
let detectCanvas: HTMLCanvasElement | null = null;

export function BlankPagesTool() {
  const { t } = useTranslation(['common', 'tools']);

  const [src, setSrc] = useState<{ file: File; bytes: Uint8Array } | null>(null);
  const [count, setCount] = useState(0);
  const [probeError, setProbeError] = useState<string | ErrorDetail | null>(null);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [error, setError] = useState<string | ErrorDetail | null>(null);
  const [removing, setRemoving] = useState(false);

  const genRef = useRef(0);
  const probePending = Boolean(src && count === 0);

  const makeSrc = useCallback(async (file: File) => {
    setSrc({ file, bytes: new Uint8Array(await file.arrayBuffer()) });
  }, []);

  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void makeSrc(taken.files[0]);
  }, [makeSrc]);

  // Probe the page count BEFORE any decision (the split-probe flake class:
  // the CTA and the detection gate await this count).
  useEffect(() => {
    const gen = (genRef.current += 1);
    setProbeError(null);
    setCount(0);
    setVerdicts([]);
    setSelected(new Set());
    setError(null);
    setBusy(false);
    if (!src) return;
    void (async () => {
      try {
        const c = await getPageCount(src.bytes);
        if (genRef.current !== gen) return;
        setCount(c);
      } catch (e) {
        if (genRef.current !== gen) return;
        setProbeError(
          engineErrorDetail(e, t('blank.err_load'), { title: t('blank.err_crashed'), detail: t('blank.err_crashed_detail') }, () => {
            void makeSrc(src.file);
          }),
        );
      }
    })();
  }, [src, t, makeSrc]);

  const detect = useCallback(async () => {
    if (!src || count === 0 || busy) return;
    const genAtStart = genRef.current;
    setBusy(true);
    setError(null);
    setVerdicts([]);
    setSelected(new Set());
    setProgress({ value: 2, label: t('blank.progress_start', { total: count }) });
    const found: Verdict[] = [];
    try {
      for (let p = 1; p <= count; p += 1) {
        if (genRef.current !== genAtStart) return; // swap/reset/cancel — drop stale work
        // Digital fast path: a non-empty text layer is content, no render.
        const items = await getVisualTextItems(src.bytes, p);
        if (genRef.current !== genAtStart) return;
        if (items.length > 0) {
          found.push({ page: p, verdict: 'content', ink: 1 });
        } else {
          const size = await getPageVisualSize(src.bytes, p);
          const { scale, clamped } = blankRasterScale(size.width, size.height);
          detectCanvas ??= document.createElement('canvas');
          detectCanvas.width = Math.max(1, Math.round(size.width * scale));
          detectCanvas.height = Math.max(1, Math.round(size.height * scale));
          await renderPageToCanvas(src.bytes, p, detectCanvas, scale);
          if (genRef.current !== genAtStart) return;
          const ctx = detectCanvas.getContext('2d');
          const img = ctx ? ctx.getImageData(0, 0, detectCanvas.width, detectCanvas.height) : null;
          const stats = img ? analyzeInk(img) : { inkRatio: 0, stddev: 0 };
          found.push({ page: p, verdict: classifyBlank(stats, clamped), ink: stats.inkRatio });
        }
        if (genRef.current !== genAtStart) return;
        // Stream into the review list as pages land (research §R2 streaming).
        const snapshot = [...found];
        setVerdicts(snapshot);
        setSelected(new Set(snapshot.filter((v) => v.verdict === 'blank').map((v) => v.page)));
        setProgress({
          value: 2 + Math.round((p / count) * 90),
          label: t('blank.progress_pages', { done: p, total: count }),
        });
        // Per-page yield: let the tab breathe between rasters.
        await new Promise((r) => setTimeout(r, 0));
      }
      setProgress({ value: 100, label: t('blank.progress_done', { blanks: found.filter((v) => v.verdict === 'blank').length }) });
    } catch (e) {
      if (genRef.current !== genAtStart) return;
      setError(engineErrorDetail(e, t('blank.err_generic'), { title: t('blank.err_crashed'), detail: t('blank.err_crashed_detail') }, () => void detect()));
    } finally {
      setBusy(false);
    }
  }, [src, count, busy, t]);

  const remove = useCallback(async () => {
    if (!src || selected.size === 0 || removing) return;
    const genAtStart = genRef.current;
    setRemoving(true);
    setError(null);
    try {
      const out = await engine.removePages(src.bytes, [...selected]);
      const stem = src.file.name.replace(/\.pdf$/i, '');
      await deliverBytes(out, `${stem}-da-xoa-trang.pdf`, 'download');
      setProgress({ value: 100, label: t('blank.removed_done', { kept: count - selected.size }) });
    } catch (e) {
      if (genRef.current !== genAtStart) return;
      setError(engineErrorDetail(e, t('blank.err_remove'), { title: t('blank.err_crashed'), detail: t('blank.err_crashed_detail') }, () => void remove()));
    } finally {
      setRemoving(false);
    }
  }, [src, selected, removing, count, t]);

  const toggle = (page: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  };

  const blankPages = verdicts.filter((v) => v.verdict === 'blank').map((v) => v.page);
  const { urlFor, observe } = useThumbnails(
    src && count > 0 ? Array.from({ length: count }, (_, i) => ({ id: `bp-${i + 1}`, bytes: src.bytes, page: i + 1 })) : [],
  );

  const badgeLabel = (v: BlankVerdict): string =>
    v === 'blank' ? t('blank.badge_blank') : v === 'near' ? t('blank.badge_near') : v === 'unknown' ? t('blank.badge_unknown') : '';

  const capped = count > COMPARE_PAGE_CAP;

  return (
    <WorkspaceShell
      title={t('blank.title')}
      meta={src && count > 0 ? t('meta.file_pages', { name: src.file.name, count, size: formatBytes(src.file.size) }) : undefined}
      steps={[
        { key: 'pick', label: t('steps.pick'), state: src ? 'done' : 'now' },
        { key: 'detect', label: t('blank.step_detect'), state: verdicts.length > 0 ? 'done' : src && count > 0 ? 'now' : 'todo' },
        { key: 'remove', label: t('blank.step_remove'), state: selected.size > 0 ? 'now' : 'todo' },
      ]}
      error={error ?? probeError ?? null}
      progress={busy || removing ? progress : null}
      side={
        <>
          <Hint variant="info" dismissKey="hint-blank-honesty">
            {t('blank.honest', { ink: Math.round(BLANK_INK_MAX * 1000) / 10, stddev: BLANK_STDDEV_MAX })}
          </Hint>
          <p className="text-[12.5px] leading-relaxed text-text-muted">{t('blank.side_note')}</p>
        </>
      }
      onReset={() => {
        genRef.current += 1;
        setSrc(null);
        setCount(0);
        setProbeError(null);
        setVerdicts([]);
        setSelected(new Set());
        setProgress(null);
        setError(null);
        setRemoving(false);
      }}
    >
      {!src ? (
        <Dropzone
          title={t('blank.dropzone_title')}
          hint={t('blank.dropzone_hint')}
          accept="application/pdf,.pdf"
          multiple={false}
          onFiles={(f) => f[0] && void makeSrc(f[0])}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {probePending ? <p className="text-[13px] text-text-muted">{t('blank.probing')}</p> : null}
          {capped && !probePending && verdicts.length === 0 ? (
            <p className="rounded-lg border border-border-strong bg-surface-card p-2.5 text-[13px]">
              {t('blank.big_confirm', { total: count })}
            </p>
          ) : null}
          {verdicts.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {capped ? (
                <Button onClick={() => void detect()} disabled={!src || probePending || Boolean(probeError) || busy}>
                  {t('blank.cta_anyway')}
                </Button>
              ) : (
                <Button onClick={() => void detect()} disabled={!src || probePending || Boolean(probeError) || busy}>
                  {t('blank.cta')}
                </Button>
              )}
              {busy ? (
                <Button variant="secondary" onClick={() => { genRef.current += 1; setBusy(false); setProgress(null); }}>
                  {t('blank.cancel')}
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-text-muted">
                  {t('blank.summary', {
                    blanks: blankPages.length,
                    near: verdicts.filter((v) => v.verdict === 'near').length,
                    unknown: verdicts.filter((v) => v.verdict === 'unknown').length,
                  })}
                </span>
                {blankPages.length > 0 ? (
                  <Button variant="secondary" onClick={() => setSelected(new Set(blankPages))}>
                    {t('blank.select_all_blank')}
                  </Button>
                ) : null}
                <Button onClick={() => void remove()} disabled={selected.size === 0 || busy || removing}>
                  {removing ? t('blank.removing') : t('blank.cta_remove', { count: selected.size })}
                </Button>
              </div>
              <ThumbnailStrip
                pages={Array.from({ length: count }, (_, i) => ({
                  key: `bp-${i + 1}`,
                  pageNumber: i + 1,
                  url: urlFor(`bp-${i + 1}`),
                  selected: selected.has(i + 1),
                }))}
                fullscreenTitle={(n) => t('a11y.page_n', { n })}
                closeLabel={t('a11y.close')}
                onToggle={(n) => toggle(n)}
                register={observe}
                tileBadge={(n) => {
                  const v = verdicts.find((x) => x.page === n);
                  if (!v) return null;
                  const label = badgeLabel(v.verdict);
                  if (!label) return null;
                  const tone =
                    v.verdict === 'blank' ? 'bg-tone-green-soft text-tone-green' : v.verdict === 'near' ? 'bg-tone-orange-soft text-tone-orange' : 'bg-tone-purple-soft text-tone-purple';
                  return (
                    <span className={`inline-block rounded-md px-1.75 py-0.5 text-[11px] font-bold ${tone}`}>
                      {label} · {(v.ink * 100).toFixed(1)}%
                    </span>
                  );
                }}
              />
            </>
          )}
        </div>
      )}
    </WorkspaceShell>
  );
}
