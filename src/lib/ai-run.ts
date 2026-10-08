/*
 * AI OCR run orchestrator (v0.5.0 phase 4a). Drives the injected worker
 * client through: download (progress + cancel) → engine load → pages
 * (page-indexed, page-boundary cancel) → benchmark-on-first-use. Node-side
 * unit-testable: the client is structural, not the concrete class.
 *
 * Crash recovery (F6): a WorkerCrashError from any page rejects the run
 * with the page index it died on — the tool offers resume from there
 * (results are page-indexed; the engine reload after restart is a
 * cache-hit).
 */
import type { RasterImageData } from '../workers/pdf.worker';
import type { OcrPageOptions } from '../workers/ai-ocr.worker';
import type { DownloadProgress } from './ai-models';
import { WorkerCrashError } from './ai-worker-client';
import {
  adapterFingerprint,
  detectHardware,
  isBenchmarkStale,
  resolveTier,
  saveBenchmarkRecord,
  createBenchmarkStore,
  type BenchmarkStore,
  type TierResolution,
} from './capability';

export interface AiPageResult {
  page: number;
  text: string;
  ms: number;
  genTokens: number;
}

export interface AiRunEvents {
  onDownloadProgress?: (p: DownloadProgress) => void;
  onPage?: (current: number, total: number) => void;
  onToken?: (page: number, chunk: string) => void;
  onCrash?: (failedAtPage: number) => void;
  onTierAfter?: (tier: TierResolution) => void;
}

/** Structural client surface — AiWorkerClient satisfies it; tests fake it. */
export interface AiRunClient {
  ensureLoaded(
    modelId: string,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<{ loadMs: number; device: 'webgpu' | 'wasm' | 'mock' }>;
  downloadModel(
    modelId: string,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<{ bytes: number; downloaded: number }>;
  cancelDownload(): Promise<void>;
  ocrPage(
    image: RasterImageData,
    onToken: (chunk: string) => void,
    opts?: OcrPageOptions,
  ): Promise<{
    text: string;
    ms: number;
    genTokens: number;
    tokPerSec: number;
    firstTokenMs: number | null;
  }>;
  isCached(modelId: string): Promise<boolean>;
  getDownloadInfo(modelId: string): Promise<{
    cached: boolean;
    filesCached: number;
    filesTotal: number;
    totalBytes: number;
  }>;
  clearCache(modelId: string): Promise<number>;
}

export async function downloadIfNeeded(
  client: AiRunClient,
  modelId: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  if (await client.isCached(modelId)) return;
  await client.downloadModel(modelId, (p) => onProgress?.(p));
}

/** Tier label (D4) — estimate + any stored benchmark, per resolution order. */
export async function aiTierEstimate(): Promise<TierResolution> {
  const hardware = await detectHardware();
  const benchmarks = await createBenchmarkStore().loadAll();
  return resolveTier(hardware, benchmarks['glm-ocr']);
}

/**
 * Run pages sequentially. `startPage` (1-based) enables resume after a
 * crash or a page-boundary cancel. Returns the page-indexed results; after
 * the SECOND completed page of a fresh fingerprint the measured benchmark
 * is persisted and the refined tier surfaces via onTierAfter (T5 — the
 * first real page acted as the discarded warmup).
 */
export async function runAiPages(
  client: AiRunClient,
  pageCount: number,
  /** Renders one page (1-based) — pages are materialized ONE at a time
   * (100 pre-rendered rasters would hold ~700MB). */
  renderPage: (page: number) => Promise<RasterImageData>,
  events: AiRunEvents,
  opts: {
    startPage?: number;
    shouldContinue?: () => boolean;
    maxNewTokensPerPage?: number;
    benchmarkStore?: BenchmarkStore;
  } = {},
): Promise<{ results: AiPageResult[]; completedAll: boolean; tierAfter?: TierResolution }> {
  const startPage = opts.startPage ?? 1;
  const results: AiPageResult[] = [];
  const fingerprint = adapterFingerprint((await detectHardware()).adapter);
  const store = opts.benchmarkStore ?? createBenchmarkStore();
  const existing = (await store.loadAll())['glm-ocr'];
  const needsBenchmark =
    !existing || isBenchmarkStale(existing, fingerprint) || existing.condition !== 'webgpu';
  await client.ensureLoaded('glm-ocr', (p) => events.onDownloadProgress?.(p));

  let firstColdMs: number | null = null;
  for (let i = startPage; i <= pageCount; i++) {
    if (opts.shouldContinue && !opts.shouldContinue()) {
      return { results, completedAll: false };
    }
    events.onPage?.(i, pageCount);
    try {
      const r = await client.ocrPage(
        await renderPage(i),
        (chunk) => events.onToken?.(i, chunk),
        { maxNewTokens: opts.maxNewTokensPerPage ?? 4096 },
      );
      if (firstColdMs === null) firstColdMs = r.firstTokenMs;
      results.push({ page: i, text: r.text, ms: r.ms, genTokens: r.genTokens });
      if (needsBenchmark && results.length === 2 && r.tokPerSec > 0) {
        // Best-effort: private-mode browsers have no IndexedDB — the OCR run
        // must never fail over benchmark bookkeeping.
        try {
          const rec = await saveBenchmarkRecord(
            'glm-ocr',
            'webgpu',
            fingerprint,
            r.tokPerSec,
            firstColdMs,
            store,
          );
          events.onTierAfter?.(resolveTier(await detectHardware(), rec));
        } catch {
          /* estimate-only tiering stays honest in the UI */
        }
      }
    } catch (err) {
      // comlink rebuilds thrown errors message-only — the crash class never
      // survives the boundary, so detect by the canonical message too.
      const isCrash =
        err instanceof WorkerCrashError ||
        (err instanceof Error && err.message.includes('AI worker crashed'));
      if (isCrash) {
        events.onCrash?.(i); // page i never completed — resume from there
      }
      throw err;
    }
  }
  return { results, completedAll: true };
}
