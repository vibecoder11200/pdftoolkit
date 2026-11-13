import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { renderPageToCanvas } from '../../engine/pdfjs';
import { changedMask, findRegions, heatmap } from '../../lib/visual-diff';

/*
 * Phase-6 visual diff (compare VISUAL mode): raster-level change heatmap
 * for one page pair. Bounded raster scale (long edge 760), noise
 * tolerance, connected regions with prev/next navigation.
 *
 * Disclosure (verbatim posture): pixel difference is NOT semantic or
 * security equivalence - the UI states it next to the results.
 */

const VISUAL_LONG_EDGE = 760;

export function VisualPairDiff({
  bytesA,
  bytesB,
  oldPage,
  newPage,
}: {
  bytesA: Uint8Array;
  bytesB: Uint8Array;
  oldPage: number;
  newPage: number | null;
}) {
  const { t } = useTranslation('common');
  const [tolerance, setTolerance] = useState(8);
  const [result, setResult] = useState<{ regionCount: number; overflow: boolean; ratio: number } | null>(null);
  const [nav, setNav] = useState<{ idx: number; total: number } | null>(null);
  const [sizeMismatch, setSizeMismatch] = useState(false);
  const regionsRef = useRef<{ x: number; y: number; width: number; height: number }[]>([]);
  const canvasHostRef = useRef<HTMLDivElement>(null);

  const runDiff = useCallback(async () => {
    const host = canvasHostRef.current;
    if (!host || newPage === null) return;
    const ca = document.createElement('canvas');
    const cb = document.createElement('canvas');
    await renderPageToCanvas(bytesA, oldPage, ca, 1);
    await renderPageToCanvas(bytesB, newPage, cb, 1);
    const longEdge = Math.max(ca.width, ca.height);
    const scale = Math.min(1, VISUAL_LONG_EDGE / longEdge);
    await renderPageToCanvas(bytesA, oldPage, ca, scale);
    await renderPageToCanvas(bytesB, newPage, cb, scale);
    if (ca.width !== cb.width || ca.height !== cb.height) {
      setSizeMismatch(true);
      return;
    }
    const ctxA = ca.getContext('2d');
    const cbx = cb.getContext('2d');
    if (!ctxA || !cbx) return;
    const imgA = ctxA.getImageData(0, 0, ca.width, ca.height);
    const imgB = cbx.getImageData(0, 0, cb.width, cb.height);
    const mask = changedMask(imgA, imgB, tolerance);
    const { regions, overflow } = findRegions(mask, ca.width, ca.height);
    regionsRef.current = regions;
    const changed = mask.reduce((m, v) => m + v, 0);
    setResult({ regionCount: regions.length, overflow, ratio: changed / (ca.width * ca.height) });
    setNav(regions.length > 0 ? { idx: 0, total: regions.length } : null);
    const hm = heatmap(imgB, mask, ca.width, ca.height);
    const out = document.createElement('canvas');
    out.width = ca.width;
    out.height = ca.height;
    const octx = out.getContext('2d');
    if (octx) {
      const img = octx.createImageData(ca.width, ca.height);
      img.data.set(hm);
      octx.putImageData(img, 0, 0);
      host.replaceChildren(out);
    }
  }, [bytesA, bytesB, oldPage, newPage, sizeMismatch, tolerance]);

  const focusRegion = (idx: number) => {
    const host = canvasHostRef.current;
    const r = regionsRef.current[idx];
    if (!host || !r) return;
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setNav({ idx, total: regionsRef.current.length });
  };

  if (newPage === null || sizeMismatch) {
    return <p className="text-[12.5px] text-text-muted">{t('visual.size_note')}</p>;
  }

  return (
    <div className="mt-2 rounded-lg border border-border-strong p-2" data-testid="visual-diff-panel">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <button
          type="button"
          className="min-h-9 rounded-lg border border-accent px-3 font-semibold text-accent"
          data-testid="visual-run"
          onClick={() => void runDiff()}
        >
          {t('visual.run')}
        </button>
        <label className="flex items-center gap-1">
          {t('visual.tolerance')}
          <input
            type="range"
            min={0}
            max={48}
            value={tolerance}
            data-testid="visual-tolerance"
            onChange={(e) => setTolerance(Number(e.target.value))}
          />
        </label>
        {result && (
          <span data-testid="visual-regions">
            {t('visual.regions', { n: result.regionCount })}
            {result.overflow ? ' · ' + t('visual.overflow') : ''}
            {` · ${(result.ratio * 100).toFixed(2)}%`}
          </span>
        )}
      </div>
      {nav && (
        <div className="mt-1 flex items-center gap-1 text-[12.5px]">
          <button
            type="button"
            className="min-h-8 rounded border border-border-strong px-2"
            data-testid="visual-prev"
            onClick={() => focusRegion((nav.idx - 1 + nav.total) % nav.total)}
          >
            ←
          </button>
          <span data-testid="visual-nav">
            {t('visual.region_n', { current: nav.idx + 1, total: nav.total })}
            {regionsRef.current[nav.idx]
              ? ` | ${regionsRef.current[nav.idx]!.width}x${regionsRef.current[nav.idx]!.height}px`
              : ''}
          </span>
          <button
            type="button"
            className="min-h-8 rounded border border-border-strong px-2"
            data-testid="visual-next"
            onClick={() => focusRegion((nav.idx + 1) % nav.total)}
          >
            →
          </button>
          <span className="ml-2 text-[11px] text-tone-orange" data-testid="visual-not-security">
            {t('visual.not_security')}
          </span>
        </div>
      )}
      <div ref={canvasHostRef} data-testid="visual-heatmap-host" className="mt-1" />
    </div>
  );
}
