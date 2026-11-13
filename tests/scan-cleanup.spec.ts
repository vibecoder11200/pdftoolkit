import { describe, expect, it } from 'vitest';

import {
  applyCleanup,
  assertExportAllocation,
  CLEANUP_DEFAULTS,
  CleanupBudgetError,
  deskewSearch,
  rotateRaster,
} from '../src/lib/scan-cleanup';
import type { Raster } from '../src/lib/scan-cleanup';

/*
 * Phase-6 scan-cleanup pixel suite: deskew search recovers planted skews,
 * transforms are bounded + typed, allocation gate refuses with typed
 * errors (never silent clamping).
 */

const blankRaster = (w: number, h: number): Raster => ({
  data: new Uint8ClampedArray(w * h * 4).fill(255),
  width: w,
  height: h,
});

/** Draw a thick "text line" (dark bar) rotated by angleDeg around center. */
function drawRotatedBar(raster: Raster, angleDeg: number): void {
  const rad = (angleDeg * Math.PI) / 180;
  const cx = raster.width / 2;
  const cy = raster.height / 2;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (const len of [-180, -90, 0, 90, 180]) {
    // 5 bars at different vertical offsets (like text lines)
    const oy = len * 0.8;
    for (let t = -160; t <= 160; t += 1) {
      const x = Math.round(cx + t * cos - oy * sin);
      const y = Math.round(cy + t * sin + oy * cos);
      for (let dy = 0; dy < 4; dy += 1) {
        for (let dx = 0; dx < 40; dx += 1) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || px >= raster.width || py < 0 || py >= raster.height) continue;
          const i = (py * raster.width + px) * 4;
          raster.data[i] = 20;
          raster.data[i + 1] = 20;
          raster.data[i + 2] = 20;
          raster.data[i + 3] = 255;
        }
      }
    }
  }
}

describe('deskew search', () => {
  it('recovers a planted +4deg skew within one step', () => {
    const r = blankRaster(400, 560);
    drawRotatedBar(r, -4); // content skewed -4deg -> correction +4
    const v = deskewSearch(r);
    expect(Math.abs(v.angle - 4)).toBeLessThanOrEqual(1.0);
  });

  it('flat raster: angle 0 wins (no false skew)', () => {
    const r = blankRaster(400, 560);
    const v = deskewSearch(r);
    expect(v.angle).toBe(0);
  });
});

describe('rotateRaster', () => {
  it('identity at 0 (same buffer)', () => {
    const r = blankRaster(8, 8);
    expect(rotateRaster(r, 0)).toBe(r);
  });

  it('rotation CORRECTS the planted skew (search+apply pipeline closure)', () => {
    // the real invariant: plant -4deg, search says +4, applying +4 leaves ~0
    const r = blankRaster(400, 560);
    drawRotatedBar(r, -4);
    const v = deskewSearch(r);
    const corrected = rotateRaster(r, v.angle);
    const after = deskewSearch(corrected);
    expect(Math.abs(after.angle)).toBeLessThanOrEqual(1.0);
  });
});

describe('applyCleanup modes', () => {
  it('grayscale flattens channels to luma', () => {
    const r = { data: new Uint8ClampedArray([250, 10, 10, 255]), width: 1, height: 1 };
    const out = applyCleanup(r, { ...CLEANUP_DEFAULTS, mode: 'grayscale' });
    const g = out.data[0]!;
    expect(out.data[1]).toBe(g);
    expect(out.data[2]).toBe(g);
    expect(g).toBeGreaterThan(60);
    expect(g).toBeLessThan(100); // 0.299*250 = 74.75
  });

  it('threshold binarizes around the threshold', () => {
    const r = {
      data: new Uint8ClampedArray([
        250, 250, 250, 255, // light
        20, 20, 20, 255, // dark
      ]),
      width: 2,
      height: 1,
    };
    const out = applyCleanup(r, { ...CLEANUP_DEFAULTS, mode: 'threshold', threshold: 128 });
    expect(out.data[0]).toBe(255);
    expect(out.data[4]).toBe(0);
  });

  it('adaptive binarize keeps ink vs paper separated', () => {
    const r = {
      data: new Uint8ClampedArray([
        240, 240, 240, 255,
        240, 240, 240, 255,
        240, 240, 240, 255,
        30, 30, 30, 255,
      ]),
      width: 2,
      height: 2,
    };
    const out = applyCleanup(r, { ...CLEANUP_DEFAULTS, mode: 'adaptive', blockSize: 15 });
    // ink pixel (bottom-right) goes black; paper stays white
    expect(out.data[4 * 3]).toBe(0);
    expect(out.data[0]).toBe(255);
  });

  it('alpha is forced to 255 in every mode (JPEG-safe)', () => {
    const r = { data: new Uint8ClampedArray([10, 20, 30, 0]), width: 1, height: 1 };
    for (const mode of ['none', 'grayscale', 'threshold'] as const) {
      const out = applyCleanup(r, { ...CLEANUP_DEFAULTS, mode });
      expect(out.data[3]).toBe(255);
    }
  });
});

describe('export allocation gate', () => {
  it('pass-through within budget returns dimensions', () => {
    const a = assertExportAllocation(4, 595, 842, 150);
    expect(a.width).toBe(1240);
    expect(a.height).toBe(1754);
  });

  it('edge cap refuses big DPI on big page (typed error)', () => {
    expect(() => assertExportAllocation(1, 1190, 1684, 300)).toThrow(CleanupBudgetError);
  });

  it('page-pixel cap refuses, total budget refuses at scale', () => {
    expect(() => assertExportAllocation(1, 2000, 20000, 72)).toThrow(CleanupBudgetError);
    expect(() => assertExportAllocation(200, 595, 842, 300)).toThrow(CleanupBudgetError);
  });
});
