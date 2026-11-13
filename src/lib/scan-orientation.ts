/*
 * Phase-6 RT5 orientation detector seam (suggestion + confirm, NEVER
 * auto-apply — see reports/rt5-orientation-decision.md).
 *
 * Runs the REAL local DetectOS (tesseract.js `worker.detect`) with the
 * LEGACY core + osd.traineddata pinned in scripts/tessdata-manifest.json.
 * Assets fetch same-origin on first use into the EXISTING OCR Cache API
 * store (never precached — 17MB budget invariant intact). `?osd-mock=1`
 * drives a canned verdict for e2e (same seam class as `?ai-mock=1`).
 */

import { createWorker, type Worker } from 'tesseract.js';

import { OCR_CACHE_NAME, ocrAssetUrl } from './ocr';

/** Legacy (combined) cores — required by worker.detect; the LSTM-only
 * builds throw "`worker.detect` requires Legacy model" (RT5 spike finding). */
export const ORIENTATION_CORE_ASSETS = [
  'tesseract-core/tesseract-core-relaxedsimd.wasm.js',
  'tesseract-core/tesseract-core-simd.wasm.js',
  'tesseract-core/tesseract-core.wasm.js',
  'tessdata/osd.traineddata.gz',
] as const;

export interface OrientationVerdict {
  /** Suggested rotation to CORRECT the page (DetectOS reports the skew as
   * read — the correction is its complement). */
  suggestDegrees: 0 | 90 | 180 | 270;
  /** Detector's own confidence (0..1) — uncalibrated, disclosed as such. */
  confidence: number | null;
}

/** Pins orientation assets (legacy cores + osd) on first use. */
export async function ensureOrientationAssets(): Promise<void> {
  const storage = globalThis.caches;
  if (!storage) throw new Error('Cache API unavailable — orientation assets cannot be pinned');
  const cache = await storage.open(OCR_CACHE_NAME);
  for (const file of ORIENTATION_CORE_ASSETS) {
    const url = ocrAssetUrl(file);
    const hit = await cache.match(url);
    if (hit) continue;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} (${url})`);
    await cache.put(url, response);
  }
}

let cachedWorker: Worker | null = null;

/** Detect page orientation from a rendered raster. The verdict is a
 * SUGGESTION — the caller MUST surface confirm + manual controls. */
export async function detectOrientation(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<OrientationVerdict> {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('osd-mock')) {
    return { suggestDegrees: 180, confidence: 0.42 };
  }
  await ensureOrientationAssets();
  if (!cachedWorker) {
    cachedWorker = await createWorker('osd', 0, {
      legacyCore: true,
      legacyLang: true,
      corePath: ocrAssetUrl('tesseract-core'),
      langPath: ocrAssetUrl('tessdata'),
      workerBlobURL: false,
    });
  }
  const r = await cachedWorker.detect(canvas);
  const deg = r.data.orientation_degrees;
  if (deg === null || deg === undefined) {
    return { suggestDegrees: 0, confidence: null };
  }
  // DetectOS reports how the text reads (0/90/180/270 clockwise in its
  // own convention); the correction is the complement rotation.
  const correction = ((360 - deg) % 360) as 0 | 90 | 180 | 270;
  return { suggestDegrees: correction, confidence: r.data.orientation_confidence ?? null };
}
