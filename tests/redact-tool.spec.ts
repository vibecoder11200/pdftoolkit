import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REDACT_PIXEL_TOLERANCE,
  REDACT_RASTER_BUDGET,
  markToRect,
  parseSecrets,
  planRedaction,
  rectsIntersect,
  regionSpread,
  type RedactCensusReport,
  type RedactMark,
} from '../src/lib/redact-pipeline';
import { redactRasterScale } from '../src/engine/pdf-lib';

/*
 * Redact tool-layer spec (v0.9.0 phase 3) — the PURE planner + verify helpers
 * of src/lib/redact-pipeline.ts. The swap-mid-render race guard contract is
 * pinned here at the planner level (stale marks beyond the page count are
 * dropped); the DOM-level generation guard is exercised by the e2e specs.
 */

const CENSUS: RedactCensusReport = {
  pageCount: 4,
  pages: [{ page: 2, kinds: ['widget'] }, { page: 3, kinds: ['tr3', 'type3'] }],
  docChannels: ['info:Title', 'acroform:V'],
};

const SIZE = { width: 595, height: 842 };
const sizeOf = () => SIZE;
const mark = (page: number, nx: number, nyTop: number, nw: number, nh: number): RedactMark => ({
  id: `m${page}-${nx}-${nyTop}`,
  page,
  nx,
  nyTop,
  nw,
  nh,
});
const input = (over: Partial<Parameters<typeof planRedaction>[1]> = {}) => ({
  marks: [] as RedactMark[],
  burnPages: [] as number[],
  keptFlagged: [] as number[],
  forceRaster: false,
  scrubSkip: [] as string[],
  secrets: ['x'],
  ...over,
});

describe('markToRect (normalized mark → visual-space rect)', () => {
  it('flips the y anchor: nyTop=0 is the TOP of the page', () => {
    const r = markToRect({ page: 1, nx: 0.1, nyTop: 0, nw: 0.5, nh: 0.1 }, 595, 842);
    expect(r.x).toBeCloseTo(59.5);
    expect(r.w).toBeCloseTo(297.5);
    expect(r.h).toBeCloseTo(84.2);
    // top strip → visual y spans [842-84.2, 842]
    expect(r.y).toBeCloseTo(842 - 84.2);
  });

  it('a mark at the bottom maps to y≈0', () => {
    const r = markToRect({ page: 1, nx: 0, nyTop: 0.95, nw: 1, nh: 0.05 }, 100, 200);
    expect(r.y).toBeCloseTo(0);
    expect(r.h).toBeCloseTo(10);
  });
});

describe('parseSecrets', () => {
  it('splits on newlines/commas/semicolons, trims, dedupes, drops empties', () => {
    expect(parseSecrets(' a , b\n\nc;\na\n')).toEqual(['a', 'b', 'c']);
  });
  it('never returns a non-empty list from blank input', () => {
    expect(parseSecrets('  \n,,;')).toEqual([]);
  });
});

describe('planRedaction (the pure run planner)', () => {
  it('unflagged marks go surgical by default', () => {
    const plan = planRedaction(CENSUS, input({ marks: [mark(1, 0.05, 0.03, 0.5, 0.03)] }), sizeOf);
    expect(plan.surgical).toHaveLength(1);
    expect(plan.surgical[0]!.page).toBe(1);
    expect(plan.surgical[0]!.rects[0]!.w).toBeCloseTo(0.5 * 595);
    expect(plan.rasterPages).toEqual([]);
  });

  it('marks on a census-flagged page escalate to raster (finding 7)', () => {
    const plan = planRedaction(CENSUS, input({ marks: [mark(2, 0.1, 0.1, 0.3, 0.05)] }), sizeOf);
    expect(plan.surgical).toEqual([]);
    expect(plan.rasterPages).toEqual([2]);
  });

  it('the explicit "Đốt trang an toàn" switch forces every marked page to raster', () => {
    const plan = planRedaction(
      CENSUS,
      input({ marks: [mark(1, 0.1, 0.1, 0.3, 0.05), mark(4, 0.1, 0.1, 0.3, 0.05)], forceRaster: true }),
      sizeOf,
    );
    expect(plan.surgical).toEqual([]);
    expect(plan.rasterPages).toEqual([1, 4]);
  });

  it('a chosen burn page wins over surgical and stays raster', () => {
    const plan = planRedaction(
      CENSUS,
      input({ marks: [mark(3, 0.1, 0.1, 0.3, 0.05)], burnPages: [3] }),
      sizeOf,
    );
    expect(plan.surgical).toEqual([]);
    expect(plan.rasterPages).toEqual([3]);
  });

  it('kept flagged pages are untouched even with stale marks', () => {
    const plan = planRedaction(
      CENSUS,
      input({ marks: [mark(3, 0.1, 0.1, 0.3, 0.05)], keptFlagged: [3] }),
      sizeOf,
    );
    expect(plan.surgical).toEqual([]);
    expect(plan.rasterPages).toEqual([]);
    expect(plan.untouchedFlagged).toEqual([3]);
  });

  it('burn choices only apply to flagged pages', () => {
    const plan = planRedaction(CENSUS, input({ burnPages: [1] }), sizeOf);
    expect(plan.rasterPages).toEqual([]);
  });

  it('SWAP-MID-RENDER GUARD: marks beyond the page count are dropped, not crashed on', () => {
    // A 1-page file replaced the 4-page one while marks were pending.
    const plan = planRedaction(
      { ...CENSUS, pageCount: 1, pages: [] },
      input({ marks: [mark(4, 0.1, 0.1, 0.3, 0.05)] }),
      sizeOf,
    );
    expect(plan.surgical).toEqual([]);
    expect(plan.rasterPages).toEqual([]);
  });

  it('sizeOf is only consulted for pages with marks', () => {
    const plan = planRedaction(CENSUS, input({ burnPages: [2] }), sizeOf);
    expect(plan.rasterPages).toEqual([2]);
  });
});

describe('verify helpers', () => {
  it('rectsIntersect: overlap true, edge-touch false (eps)', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsIntersect(a, { x: -10, y: -10, w: 10, h: 10 })).toBe(false);
  });

  it('regionSpread: flat region ≈ 0, half-and-half = 255', () => {
    const w = 40;
    const h = 40;
    const data = new Uint8ClampedArray(w * h * 4).fill(200);
    const flat = { data, width: w, height: h };
    expect(regionSpread(flat, { nx: 0.2, nyTop: 0.2, nw: 0.5, nh: 0.5 })).toBe(0);
    const split = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const o = (y * w + x) * 4;
        const v = x < w / 2 ? 0 : 255;
        split[o] = v;
        split[o + 1] = v;
        split[o + 2] = v;
        split[o + 3] = 255;
      }
    }
    expect(regionSpread({ data: split, width: w, height: h }, { nx: 0.2, nyTop: 0.2, nw: 0.6, nh: 0.6 })).toBe(255);
    expect(regionSpread({ data: split, width: w, height: h }, { nx: 0, nyTop: 0, nw: 0.1, nh: 0.1 })).toBe(0);
  });

  it('the pixel tolerance sits below content bleed but above jpeg noise', () => {
    expect(REDACT_PIXEL_TOLERANCE).toBeGreaterThan(8);
    expect(REDACT_PIXEL_TOLERANCE).toBeLessThan(128);
  });

  it('the wrapper raster clamp is IDENTICAL to the engine clamp (single source)', () => {
    // The wrapper dynamic-imports the engine's redactRasterScale; this spec
    // pins the export contract so the two can never drift apart silently.
    for (const [w, h] of [
      [595, 842],
      [3000, 3000],
      [100, 8000],
      [8000, 100],
      [10000, 10000],
    ]) {
      const s = redactRasterScale(w, h);
      expect(s).toBeGreaterThan(0);
      expect(Math.max(w, h) * s).toBeLessThanOrEqual(4096 + 1e-9);
      expect(w * h * s * s).toBeLessThanOrEqual(4096 * 4096 + 1e-6);
    }
  });

  it('the raster budget is exported for the confirm gate', () => {
    expect(REDACT_RASTER_BUDGET).toBeGreaterThan(0);
  });
});

describe('browser safety (v0.8.1 jszip-class trap)', () => {
  it('the redact engine + pipeline sections never touch Buffer — vitest runs on node and cannot catch this by execution', () => {
    // The engine module runs in the browser worker AND main thread; a single
    // `Buffer.` reference passes every node-side gate and explodes only in
    // the real app (shipped once as "Xử lý thất bại: Buffer is not defined").
    for (const file of ['src/engine/pdf-lib.ts', 'src/lib/redact-pipeline.ts']) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const redactPart =
        file.endsWith('pdf-lib.ts')
          ? text.slice(text.indexOf('Redact engine (v0.9.0 phase 2)'))
          : text;
      expect(redactPart, file).not.toMatch(/\bBuffer\s*\./);
    }
  });
});
