/*
 * Target-size compression math + runner (v0.13.0 phase 1). PURE module —
 * zero engine/pdf-lib/pdfjs imports (the runner's render/encode/rebuild are
 * INJECTED deps, same pattern as pdf-repair), so the ladder/interpolation/
 * pick logic is node-testable without a browser.
 *
 * Design (plan phase-01, RT-hardened): NEVER keep all page rasters in memory
 * (100 A4 pages @2x ≈ 1.6GB — forbidden). Sample-calibrated search instead:
 * a 2-page census at quality rungs estimates bytes/page; one full pass
 * measures reality; at most ONE corrective full pass keyed on the measured
 * overshoot ratio. Funding cap: ≤ 2 full passes + ≤ 10 sample encodes.
 *
 * Honesty contract: a verdict of 'met' is only issued for a MEASURED output
 * ≤ target; 'best-effort' delivers the best result with an explicit
 * not-met label; 'refuse-bigger' (every configuration produced a file
 * LARGER than the input) returns NO bytes — no meaningless output.
 */

export const TARGET_MIN_Q = 22;
/** mozjpeg quality rungs the sample census encodes (highest → lowest). */
export const QUALITY_LADDER = [80, 50, 22] as const;
/** Rung pairs re-encoded when the scale must drop (1 page x 2 rungs). */
export const LOWER_SCALE_RUNGS = [50, 22] as const;
/** Scale ladder (DPI knob), floor 1.0 — bytes do NOT interpolate across scale. */
export const SCALE_STEPS = [2.0, 1.5, 1.0] as const;
export const MAX_FULL_PASSES = 2;
export const MAX_SAMPLE_ENCODINGS = 10;
/** First estimate inflation (PDF rebuild overhead); replaced by real measures. */
export const INITIAL_OVERHEAD = 1.05;

export type TargetVerdict = 'met' | 'best-effort' | 'refuse-bigger';

export interface CompressSample {
  scale: number;
  quality: number;
  bytesPerPage: number;
}

export interface TargetPlan {
  scale: number;
  quality: number;
  estimatedTotalBytes: number;
}

export interface PickOutcome {
  /** Plan to run — the min-config plan when nothing fits by estimate. */
  plan: TargetPlan;
  /** True when the plan's estimate lands ≤ target at this scale. */
  fits: boolean;
  /** True when nothing fits AND a lower scale step could still help. */
  needLowerScale: boolean;
}

/** Census pages: first + middle (deduped, ascending). */
export function samplePagesFor(numPages: number): number[] {
  if (numPages <= 1) return [1];
  const mid = Math.max(1, Math.ceil(numPages / 2));
  return Array.from(new Set([1, mid])).sort((a, b) => a - b);
}

/** Duplicate rungs averaged, sorted by quality, sanitized to monotone
 * non-decreasing bytes (sample noise must never invert the curve). */
function rungPoints(samples: CompressSample[], scale: number): { q: number; b: number }[] {
  const points = samples
    .filter((s) => s.scale === scale)
    .reduce<{ q: number; b: number; n: number }[]>((acc, s) => {
      const found = acc.find((p) => p.q === s.quality);
      if (found) {
        found.n += 1;
        found.b += (s.bytesPerPage - found.b) / found.n;
      } else {
        acc.push({ q: s.quality, b: s.bytesPerPage, n: 1 });
      }
      return acc;
    }, [])
    .sort((a, b) => a.q - b.q)
    .map((p, i, arr) => ({ q: p.q, b: i > 0 ? Math.max(p.b, arr[i - 1]!.b) : p.b }));
  return points;
}

/**
 * Monotone piecewise-linear bytes-per-page interpolant over the samples at
 * `scale`, evaluated at `quality`. Duplicate rungs (multi-page census) are
 * averaged first; sample noise is sanitized to non-decreasing bytes; below/
 * above the encoded rung range clamps to the edge bytes. Null when the
 * scale has no samples.
 */
export function bytesPerPageAt(
  samples: CompressSample[],
  scale: number,
  quality: number,
): number | null {
  const points = rungPoints(samples, scale);
  if (points.length === 0) return null;
  if (quality <= points[0]!.q) return points[0]!.b;
  const last = points[points.length - 1]!;
  if (quality >= last.q) return last.b;
  for (let i = 1; i < points.length; i += 1) {
    const lo = points[i - 1]!;
    const hi = points[i]!;
    if (quality <= hi.q) {
      const frac = (quality - lo.q) / (hi.q - lo.q);
      return lo.b + frac * (hi.b - lo.b);
    }
  }
  return last.b;
}

/**
 * Pick the run plan for a scale: the HIGHEST quality whose interpolated
 * estimate fits the target (quality maximized subject to size), else the
 * min-config plan (q22) with needLowerScale set unless the scale floor is
 * reached. Pure — no encodes happen here.
 */
export function pickPlan(
  samples: CompressSample[],
  numPages: number,
  targetBytes: number,
  overhead: number = INITIAL_OVERHEAD,
): PickOutcome {
  const scale = samples[0]?.scale ?? SCALE_STEPS[SCALE_STEPS.length - 1];
  const qMin = TARGET_MIN_Q;
  const points = rungPoints(samples, scale);
  // The census at NON-head scales encodes only the lower rungs ([50,22]) —
  // the plan's quality must stay within the MEASURED range (choosing the
  // ladder head at an unmeasured quality would encode blind). MEASURED means
  // a rung exists in `points` — bytesPerPageAt CLAMPS out-of-range qualities
  // (an 80 query over [50,22] samples returns the q50 bytes, never null), so
  // it cannot answer "was q80 measured at this scale?" (review P0 2026-11-21).
  const qTop = points.some((p) => p.q === QUALITY_LADDER[0]) ? QUALITY_LADDER[0] : undefined;
  if (points.length === 0) {
    // No samples at this scale: the caller never reached an encode — refuse
    // honestly with the floor config (the runner guards against this).
    return {
      plan: { scale, quality: qMin, estimatedTotalBytes: targetBytes },
      fits: false,
      needLowerScale: scale > SCALE_STEPS[SCALE_STEPS.length - 1],
    };
  }
  const qMax = Math.min(qTop ?? points[points.length - 1]!.q, QUALITY_LADDER[0]);
  const bMin = bytesPerPageAt(samples, scale, qMin);
  const bMax = bytesPerPageAt(samples, scale, qMax);
  if (bMin == null || bMax == null) {
    return {
      plan: { scale, quality: qMin, estimatedTotalBytes: targetBytes },
      fits: false,
      needLowerScale: scale > SCALE_STEPS[SCALE_STEPS.length - 1],
    };
  }
  const budgetPerPage = targetBytes / (numPages * overhead);
  if (budgetPerPage >= bMax) {
    // Even the top measured rung fits — quality maxes out at it.
    return {
      plan: { scale, quality: qMax, estimatedTotalBytes: bMax * numPages * overhead },
      fits: true,
      needLowerScale: false,
    };
  }
  if (budgetPerPage < bMin) {
    return {
      plan: { scale, quality: qMin, estimatedTotalBytes: bMin * numPages * overhead },
      fits: false,
      needLowerScale: scale > SCALE_STEPS[SCALE_STEPS.length - 1],
    };
  }
  // Solve the linear segment containing the budget for the exact quality.
  let quality = qMin;
  for (let i = 1; i < points.length; i += 1) {
    const lo = points[i - 1]!;
    const hi = points[i]!;
    if (budgetPerPage <= hi.b) {
      const frac = hi.b === lo.b ? 1 : (budgetPerPage - lo.b) / (hi.b - lo.b);
      quality = lo.q + frac * (hi.q - lo.q);
      break;
    }
  }
  quality = Math.max(qMin, Math.min(qMax, quality));
  return {
    plan: { scale, quality, estimatedTotalBytes: budgetPerPage * numPages * overhead },
    fits: true,
    needLowerScale: false,
  };
}

/**
 * Corrective rung choice AFTER a measured overshoot (multi-rung: a 2x
 * overshoot jumps straight toward the floor instead of stepping once).
 * Estimate anchored on the REAL per-page bytes of the measured pass scaled
 * by the quality ratio (crude linear model — pass 2 measures the truth).
 * Null when no lower rung exists (already at TARGET_MIN_Q) — the caller
 * stops and reports best-effort/refuse-bigger honestly.
 */
export function correctiveRung(
  currentQuality: number,
  perPageRealBytes: number,
  numPages: number,
  targetBytes: number,
): { quality: number; estimatedTotalBytes: number } | null {
  const lower = QUALITY_LADDER.filter((r) => r < currentQuality);
  if (lower.length === 0) return null;
  const ratio = (perPageRealBytes * numPages) / targetBytes;
  const jump = ratio > 2.5 ? lower.length : ratio > 1.6 ? Math.min(2, lower.length) : 1;
  const quality = lower[Math.min(jump - 1, lower.length - 1)]!;
  return {
    quality,
    estimatedTotalBytes: Math.round(perPageRealBytes * numPages * (quality / currentQuality)),
  };
}

export class TargetEncodeError extends Error {
  constructor() {
    super('target-compress: jpeg encode produced no bytes');
    this.name = 'TargetEncodeError';
  }
}

export interface TargetRunDeps {
  /** Render one page at `scale` into an offscreen surface → ImageData. */
  renderImage: (page: number, scale: number) => Promise<ImageData>;
  /** mozjpeg encode (1-100 quality). Empty output is a hard error. */
  encodeJpeg: (image: ImageData, quality: number) => Promise<Uint8Array>;
  /** Rebuild the PDF from per-page JPEGs (page size preserved). */
  rebuild: (jpegs: Uint8Array[]) => Promise<Uint8Array>;
  /** Progress 0..1 with the phase the caller should label; `pass` is the
   * 1-based full-pass number when phase is 'pass'. */
  onProgress?: (
    fraction: number,
    phase: 'sample' | 'pass' | 'rebuild',
    pass?: number,
  ) => void;
}

export interface TargetRunResult {
  verdict: TargetVerdict;
  /** null for refuse-bigger — no meaningless output. */
  bytes: Uint8Array | null;
  outSize: number;
  inputBytes: number;
  targetBytes: number;
  scale: number;
  quality: number;
  passesUsed: number;
  sampleEncodes: number;
}

/**
 * The orchestrated search: sample census → scale ladder → full pass → at
 * most one corrective full pass. Streaming full passes (render → encode →
 * push JPEG only) keep the memory profile identical to the existing image
 * mode; rasters are never retained.
 */
export async function runTargetCompress(
  inputBytes: number,
  numPages: number,
  targetBytes: number,
  deps: TargetRunDeps,
): Promise<TargetRunResult> {
  if (numPages < 1) throw new Error('target-compress: numPages must be ≥ 1');
  if (targetBytes < 100 * 1024) throw new Error('target-compress: target below 100KB floor');
  const encodeCount = { n: 0, census: 0 };
  const encodeOne = async (page: number, scale: number, quality: number): Promise<Uint8Array> => {
    encodeCount.n += 1;
    const image = await deps.renderImage(page, scale);
    const jpeg = await deps.encodeJpeg(image, quality);
    if (jpeg.byteLength === 0) throw new TargetEncodeError();
    return jpeg;
  };

  // Census walk down the scale ladder (budget exactly 10: 6 + 2 + 2).
  const pages = samplePagesFor(numPages);
  let chosenScale = SCALE_STEPS[SCALE_STEPS.length - 1];
  let chosenQuality = TARGET_MIN_Q;
  for (let scaleIdx = 0; scaleIdx < SCALE_STEPS.length; scaleIdx += 1) {
    const scale = SCALE_STEPS[scaleIdx]!;
    const isHead = scaleIdx === 0;
    const rungs = isHead ? QUALITY_LADDER : LOWER_SCALE_RUNGS;
    const censusPages = isHead ? pages : [pages[0]!];
    const perRung = new Map<number, number[]>();
    census: for (const page of censusPages) {
      for (const q of rungs) {
        if (encodeCount.census >= MAX_SAMPLE_ENCODINGS) break census;
        encodeCount.census += 1;
        const jpeg = await encodeOne(page, scale, q);
        deps.onProgress?.(0.05, 'sample');
        let bucket = perRung.get(q);
        if (!bucket) perRung.set(q, (bucket = []));
        bucket.push(jpeg.byteLength);
      }
    }
    const scaleSamples: CompressSample[] = [...perRung.entries()].map(([q, arr]) => ({
      scale,
      quality: q,
      bytesPerPage: arr.reduce((a, b) => a + b, 0) / arr.length,
    }));
    const pick = pickPlan(scaleSamples, numPages, targetBytes);
    chosenScale = scale;
    chosenQuality = pick.plan.quality;
    if (pick.fits || scaleIdx === SCALE_STEPS.length - 1 || encodeCount.census >= MAX_SAMPLE_ENCODINGS) {
      break;
    }
  }

  // Full pass — stream pages, keep JPEG bytes only.
  const fullPass = async (
    quality: number,
    passNo: number,
  ): Promise<{ bytes: Uint8Array; jpegPerPage: number }> => {
    const jpegs: Uint8Array[] = [];
    for (let p = 1; p <= numPages; p += 1) {
      deps.onProgress?.(0.1 + (0.6 * (p - 1)) / numPages, 'pass', passNo);
      jpegs.push(await encodeOne(p, chosenScale, quality));
    }
    deps.onProgress?.(0.8, 'rebuild', passNo);
    const bytes = await deps.rebuild(jpegs);
    const jpegPerPage = jpegs.reduce((a, b) => a + b.byteLength, 0) / numPages;
    return { bytes, jpegPerPage };
  };

  const first = await fullPass(chosenQuality, 1);
  let result = first;
  let quality = chosenQuality;
  let passesUsed = 1;
  if (first.bytes.byteLength > targetBytes && passesUsed < MAX_FULL_PASSES) {
    const correction = correctiveRung(
      chosenQuality,
      first.jpegPerPage,
      numPages,
      targetBytes,
    );
    if (correction && correction.quality < chosenQuality) {
      quality = correction.quality;
      passesUsed = 2;
      const second = await fullPass(quality, 2);
      // Keep the SMALLER measured result: a lower quality can come out
      // LARGER in rare encoder non-monotonicity — never discard a valid
      // smaller measured output (review P3 2026-11-21).
      if (second.bytes.byteLength < first.bytes.byteLength) {
        result = second;
      } else {
        quality = chosenQuality; // the kept result IS pass 1's
        passesUsed = 1;
      }
    }
  }

  const outSize = result.bytes.byteLength;
  const verdict: TargetVerdict =
    outSize <= targetBytes ? 'met' : outSize > inputBytes ? 'refuse-bigger' : 'best-effort';
  deps.onProgress?.(1, 'rebuild');
  return {
    verdict,
    bytes: verdict === 'refuse-bigger' ? null : result.bytes,
    outSize,
    inputBytes,
    targetBytes,
    scale: chosenScale,
    quality,
    passesUsed,
    sampleEncodes: encodeCount.census,
  };
}

// token-mapped
