/*
 * Blank-page analysis (v0.11.0 phase 9, plan 261109-1101). PURE and
 * node-testable: synthetic buffers only, no DOM. The dual criteria
 * (ink fraction AND grey stddev, research §R3 / pdftl defaults) separate
 * real blank from scanner-noise white AND from solid-but-uniform color
 * (stddev≈0 with ink 1.0 is NOT blank — the pin).
 */

/** Dual-criteria thresholds (research §R3, pdftl defaults). */
export const BLANK_INK_MAX = 0.005;
export const BLANK_STDDEV_MAX = 5.0;
/** Near-blank band: above blank but below 3× — badge, unchecked by default. */
export const BLANK_NEAR_FACTOR = 3;

/** Raster scale clamps (S3): ~30 DPI by preference, then the redact
 * pixel-leg bounds — a 14400pt MediaBox must never allocate a 36MP
 * canvas (a failed allocation silently reads all-zero → the page would
 * read 'blank' → real content deleted — the data-loss path S3 exists
 * for). */
export const BLANK_DPI = 30;
export const BLANK_MAX_LONG_EDGE = 1500;
export const BLANK_MAX_PIXELS = 1.5e6;

export interface InkStats {
  /** Fraction of pixels whose grey differs from white by more than the
   * scanner-noise band (>4 levels). */
  inkRatio: number;
  /** Grey (Rec.601) stddev over ALL pixels. */
  stddev: number;
}

/** Luminance over white for one RGBA sample (alpha composited over white). */
function greyOf(r: number, g: number, b: number, a: number): number {
  if (a < 255) {
    const ka = a / 255;
    r = r * ka + 255 * (1 - ka);
    g = g * ka + 255 * (1 - ka);
    b = b * ka + 255 * (1 - ka);
  }
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Ink + grey-variance analysis over RGBA pixels (canvas ImageData shape —
 * `{data, width, height}`; node tests pass synthetic buffers). */
export function analyzeInk(img: { data: ArrayLike<number>; width: number; height: number }): InkStats {
  const n = img.width * img.height;
  if (n === 0) return { inkRatio: 0, stddev: 0 };
  let ink = 0;
  let sum = 0;
  let sumSq = 0;
  for (let p = 0; p < n; p += 1) {
    const i = p * 4;
    const grey = greyOf(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!);
    if (255 - grey > 4) ink += 1;
    sum += grey;
    sumSq += grey * grey;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { inkRatio: ink / n, stddev: Math.sqrt(variance) };
}

export type BlankVerdict = 'blank' | 'near' | 'content' | 'unknown';

/** Dual-criteria classification. `clamped` = the raster hit the scale
 * clamp ceiling AND read zero ink — the failed-allocation fingerprint —
 * which classifies 'unknown' (badge, NEVER auto-checked), never 'blank'
 * (S3's fail-closed half). */
export function classifyBlank(stats: { inkRatio: number; stddev: number }, clamped: boolean): BlankVerdict {
  if (clamped && stats.inkRatio === 0) return 'unknown';
  if (stats.inkRatio <= BLANK_INK_MAX && stats.stddev <= BLANK_STDDEV_MAX) return 'blank';
  if (stats.inkRatio <= BLANK_INK_MAX * BLANK_NEAR_FACTOR && stats.stddev <= BLANK_STDDEV_MAX * BLANK_NEAR_FACTOR) {
    return 'near';
  }
  return 'content';
}

/** Render scale for one page + whether the clamp engaged (the 'unknown'
 * fingerprint precondition). The floor keeps tiny pages readable: never
 * below the 30-DPI preference when the page is small enough for it. */
export function blankRasterScale(w: number, h: number): { scale: number; clamped: boolean } {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return { scale: 30 / 72, clamped: true };
  }
  const preference = BLANK_DPI / 72;
  const byLongEdge = BLANK_MAX_LONG_EDGE / Math.max(w, h);
  const byPixels = Math.sqrt(BLANK_MAX_PIXELS / (w * h));
  const scale = Math.min(preference, byLongEdge, byPixels);
  return { scale, clamped: scale < preference };
}
