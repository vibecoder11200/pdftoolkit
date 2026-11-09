import { describe, expect, it } from 'vitest';
import { analyzeInk, blankRasterScale, BLANK_INK_MAX, BLANK_MAX_LONG_EDGE, BLANK_MAX_PIXELS, BLANK_STDDEV_MAX, classifyBlank } from '../src/lib/blank-page';

/*
 * Blank-page analysis (v0.11.0 phase 9, plan 261109-1101). Synthetic
 * RGBA buffers only (pure lib, node-testable). The pins that matter:
 * the dual criteria (scanner-noise white stays blank; SOLID COLOR is NOT
 * blank — stddev≈0 with ink 1.0), the near class, and S3's fail-closed
 * half — a clamped zero-ink raster reads 'unknown', NEVER blank, so a
 * failed canvas allocation can never delete real content.
 */

function img(pixels: number[][][]): { data: Uint8ClampedArray; width: number; height: number } {
  // pixels: rows of [r,g,b]; one row = full width.
  const width = pixels[0]!.length;
  const height = pixels.length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [y, row] of pixels.entries()) {
    for (const [x, px] of row.entries()) {
      const i = (y * width + x) * 4;
      data[i] = px[0]!;
      data[i + 1] = px[1]!;
      data[i + 2] = px[2]!;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const solid = (r: number, g: number, b: number, w = 40, h = 30) => img(Array.from({ length: h }, () => Array.from({ length: w }, () => [r, g, b])));

describe('analyzeInk', () => {
  it('pure white: ink 0, stddev 0', () => {
    const s = analyzeInk(solid(255, 255, 255));
    expect(s).toEqual({ inkRatio: 0, stddev: 0 });
  });

  it('scanner-noise white: ink < 0.5%, stddev ~2 — still blank', () => {
    // Deterministic small perturbations inside the >4-levels band edge:
    // values differ from white by ≤4 → no ink, small stddev.
    const px = Array.from({ length: 30 }, (_, y) =>
      Array.from({ length: 40 }, (_, x) => [(x + y) % 5 === 0 ? 251 : 255, 255, 255] as [number, number, number]),
    );
    const s = analyzeInk(img(px));
    expect(s.inkRatio).toBe(0); // 4-level diff is NOT ink (strict >4)
    expect(s.stddev).toBeGreaterThan(0);
    expect(s.stddev).toBeLessThanOrEqual(BLANK_STDDEV_MAX);
  });

  it('solid colored page: stddev≈0 but ink=1 → NOT blank (dual-criteria pin)', () => {
    const s = analyzeInk(solid(200, 220, 240));
    expect(s.inkRatio).toBe(1);
    expect(s.stddev).toBeLessThanOrEqual(BLANK_STDDEV_MAX);
    expect(classifyBlank(s, false)).toBe('content');
  });

  it('real text: high ink → content', () => {
    const px = Array.from({ length: 30 }, (_, y) =>
      Array.from({ length: 40 }, (_, x) => (y > 10 && y < 20 && x % 3 === 0 ? [20, 20, 20] : [255, 255, 255])),
    );
    const s = analyzeInk(img(px));
    expect(s.inkRatio).toBeGreaterThan(0.1);
    expect(classifyBlank(s, false)).toBe('content');
  });

  it('alpha composites over white before analysis', () => {
    const w = 10;
    const h = 10;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p += 1) {
      data[p * 4] = 0;
      data[p * 4 + 1] = 0;
      data[p * 4 + 2] = 0;
      data[p * 4 + 3] = 255; // opaque black = full ink
    }
    expect(analyzeInk({ data, width: w, height: h }).inkRatio).toBe(1);
    for (let p = 0; p < w * h; p += 1) data[p * 4 + 3] = 0; // fully transparent → white
    expect(analyzeInk({ data, width: w, height: h }).inkRatio).toBe(0);
  });
});

describe('classifyBlank', () => {
  it('scanner-noise white is blank', () => {
    expect(classifyBlank({ inkRatio: 0.002, stddev: 2 }, false)).toBe('blank');
  });

  it('light header-only page lands in the near class (unchecked by default)', () => {
    expect(classifyBlank({ inkRatio: BLANK_INK_MAX * 2, stddev: BLANK_STDDEV_MAX * 2 }, false)).toBe('near');
  });

  it('the unknown verdict NEVER returns blank (S3 fail-closed half)', () => {
    expect(classifyBlank({ inkRatio: 0, stddev: 0 }, true)).toBe('unknown');
    // Ink above zero at a clamp reads normally (the clamp is not a blanket).
    expect(classifyBlank({ inkRatio: 0.2, stddev: 60 }, true)).toBe('content');
  });

  it('faint page just under 3× thresholds stays near, above → content', () => {
    expect(classifyBlank({ inkRatio: BLANK_INK_MAX * 2.9, stddev: 1 }, false)).toBe('near');
    expect(classifyBlank({ inkRatio: BLANK_INK_MAX * 3.1, stddev: 1 }, false)).toBe('content');
  });
});

describe('blankRasterScale (S3 clamp math)', () => {
  it('A4 page renders at the 30-DPI preference, no clamp', () => {
    const out = blankRasterScale(595, 842);
    expect(out.clamped).toBe(false);
    expect(out.scale).toBeCloseTo(30 / 72, 6);
  });

  it('a 14400pt MediaBox clamps to BOTH the long edge and the pixel budget', () => {
    const out = blankRasterScale(14400, 14400);
    expect(out.clamped).toBe(true);
    expect(Math.max(14400, 14400) * out.scale).toBeLessThanOrEqual(BLANK_MAX_LONG_EDGE);
    expect(14400 * out.scale * (14400 * out.scale)).toBeLessThanOrEqual(BLANK_MAX_PIXELS);
  });

  it('a wide banner page clamps by the long edge (30 DPI alone would overshoot)', () => {
    const out = blankRasterScale(6000, 600);
    expect(out.clamped).toBe(true);
    expect(6000 * out.scale).toBeLessThanOrEqual(BLANK_MAX_LONG_EDGE);
  });

  it('degenerate dims refuse to a clamped default (never NaN)', () => {
    for (const [w, h] of [[0, 100], [100, 0], [-5, 100], [Number.NaN, 100]] as const) {
      const out = blankRasterScale(w, h);
      expect(Number.isFinite(out.scale)).toBe(true);
      expect(out.clamped).toBe(true);
    }
  });
});
