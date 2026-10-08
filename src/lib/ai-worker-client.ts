/*
 * Main-side AI worker wrapper (v0.5.0 phase 2b, F6). Owns the lifecycle the
 * worker cannot see:
 *  - spawn: URL module worker (never blob); the `?ai-mock=1` flag on the
 *    PAGE URL selects the F8 test seam — the worker is spawned with
 *    `name: 'ai-mock'` (AI_MOCK_NAME), which the worker reads as self.name;
 *  - idle (10 min) / hidden (≥5 min) dispose timers, both RE-ARMED while a
 *    job is busy — a timer must never kill an in-flight OCR page (F6);
 *  - crash recovery: comlink calls to a dead worker never settle, so every
 *    delegated call registers a rejector; on worker error/messageerror all
 *    pending calls reject with WorkerCrashError and the worker respawns
 *    (the tool re-drives: engine load after restart is cache-hit fast, and
 *    page-indexed results let the user resume from the last done page);
 *  - GPU-loss degrade: a GpuLostError message from the worker respawns with
 *    device 'wasm' pinned for the next loadEngine (F6).
 */
import { proxy, wrap, type Remote } from 'comlink';
import type {
  AiOcrApi,
  AiOcrPageResult,
  DownloadInfo,
  EngineStats,
  LoadOptions,
  LoadResult,
  OcrPageOptions,
} from '../workers/ai-ocr.worker';
import type { RasterImageData } from '../workers/pdf.worker';
import type { DownloadProgress } from './ai-models';


export class WorkerCrashError extends Error {
  constructor(cause?: unknown) {
    super('AI worker crashed — it has been restarted.', { cause });
    this.name = 'WorkerCrashError';
  }
}

export class GpuLostError extends Error {
  constructor() {
    super('WebGPU device was lost — retrying on CPU (WASM).');
    this.name = 'GpuLostError';
  }
}

const GPU_LOST_MESSAGE = 'WebGPU device was lost';

export interface AiClientOptions {
  /** F8 test seam — set from the page URL `?ai-mock=1` flag; spawns the
   *  worker with `name: 'ai-mock'` (AI_MOCK_NAME in ai-ocr.worker.ts). */
  mock?: boolean;
  /** Injectable for node-side lifecycle tests (no real worker spawns). */
  spawnWorker?: () => Worker;
  /** Injectable comlink wrap for node-side tests. */
  createApi?: (worker: Worker) => Remote<AiOcrApi>;
  idleMs?: number;
  hiddenMs?: number;
  onWorkerCrash?: (restarts: number) => void;
  onGpuLost?: () => void;
}

interface PendingCall {
  reject: (err: unknown) => void;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_HIDDEN_MS = 5 * 60_000;
/** handleFatal spawn budget (see handleFatal — offline first-use otherwise
 * loops spawn/fail forever; a settled guarded() call resets the counter). */
const MAX_RESTARTS = 5;

export class AiWorkerClient {
  private readonly options: AiClientOptions;
  private worker: Worker | null = null;
  private api: Remote<AiOcrApi> | null = null;
  private pending = new Set<PendingCall>();
  private restarts = 0;
  private degradeToWasm = false;
  private idleTimer: number | null = null;
  private hiddenTimer: number | null = null;
  private visibilityHooked = false;

  constructor(options: AiClientOptions = {}) {
    this.options = options;
  }

  private spawn(): void {
    // The new URL() literal must sit DIRECTLY inside new Worker for vite to
    // bundle + fingerprint the worker chunk (an indirect URL compiles the
    // raw .ts into assets — the pdf.worker pattern), and the options object
    // must stay LITERAL-ONLY: vitest's bundled vite evals it statically, so
    // `name: this.options.mock ? …` breaks the transform. The mock seam
    // (F8) rides the standard worker `name`, read in the worker as
    // self.name === 'ai-mock' (AI_MOCK_NAME there).
    const worker =
      this.options.spawnWorker?.() ??
      (this.options.mock
        ? new Worker(new URL('../workers/ai-ocr.worker.ts', import.meta.url), {
            type: 'module',
            name: 'ai-mock',
          })
        : new Worker(new URL('../workers/ai-ocr.worker.ts', import.meta.url), {
            type: 'module',
            name: 'ai-ocr',
          }));
    worker.onerror = (e: Event) => this.handleFatal(undefined, e);
    worker.onmessageerror = () => this.handleFatal(undefined, undefined);
    this.worker = worker;
    this.api = this.options.createApi
      ? this.options.createApi(worker)
      : wrap<AiOcrApi>(worker);
  }

  private handleFatal(cause?: unknown, event?: Event): void {
    if (event) {
      // suppress console noise (does NOT stop the loop — the cap below does)
      event.preventDefault?.();
    }
    const pending = [...this.pending];
    this.pending.clear();
    for (const p of pending) p.reject(new WorkerCrashError(cause));
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
    this.api = null;
    this.restarts += 1;
    // Cap the spawn/fail loop: the worker chunk is deliberately NOT
    // precached (F9), so an offline first-use fails the module fetch —
    // an uncapped onerror here is an infinite spawn/fail/spawn until page
    // unload. A client past the cap stays dead until reload; the next
    // guarded() call rejects fast instead of respawning.
    if (this.restarts <= MAX_RESTARTS) this.spawn();
    this.options.onWorkerCrash?.(this.restarts);
  }

  /** Register a rejector so a crashed worker cannot strand the promise. */
  private guarded<T>(run: (api: Remote<AiOcrApi>) => Promise<T>): Promise<T> {
    if (!this.api) {
      if (this.restarts >= MAX_RESTARTS) {
        return Promise.reject(
          new WorkerCrashError(new Error('AI worker restart limit reached')),
        );
      }
      this.spawn();
    }
    const api = this.api!;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingCall = { reject };
      this.pending.add(entry);
      run(api)
        .then(
          (value) => {
            // A settled call proves the CURRENT worker loaded and responds —
            // it earns a fresh restart budget. Crash rejects (from
            // handleFatal, which rejects via this same chain) must NOT count.
            this.restarts = 0;
            resolve(value);
          },
          (err) => {
            if (!(err instanceof WorkerCrashError)) this.restarts = 0;
            reject(err);
          },
        )
        .finally(() => this.pending.delete(entry));
    });
  }

  /** Any activity re-arms the idle timer (busy jobs are never disposed, F6). */
  private touch(): void {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => void this.disposeIfIdle(), this.options.idleMs ?? DEFAULT_IDLE_MS);
    if (!this.visibilityHooked && typeof document !== 'undefined') {
      this.visibilityHooked = true;
      // Deliberately NOT removed in destroy(): the client is a page-lifetime
      // singleton (sharedAiClient), so one listener per page is the intended
      // cost — never a leak per spawn.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.hiddenTimer = window.setTimeout(
            () => void this.disposeIfIdle(),
            this.options.hiddenMs ?? DEFAULT_HIDDEN_MS,
          );
        } else if (this.hiddenTimer !== null) {
          window.clearTimeout(this.hiddenTimer);
          this.hiddenTimer = null;
        }
      });
    }
  }

  private async disposeIfIdle(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const busy = await api.isBusy().catch(() => true);
    if (busy) {
      this.touch(); // re-arm — never dispose under an in-flight job
      return;
    }
    await api.dispose().catch(() => undefined);
  }

  private typedError(err: unknown): unknown {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(GPU_LOST_MESSAGE)) {
      this.degradeToWasm = true;
      this.handleFatal(err);
      this.options.onGpuLost?.();
      return new GpuLostError();
    }
    return err;
  }

  get restartCount(): number {
    return this.restarts;
  }

  async isBusy(): Promise<boolean> {
    return this.guarded((api) => api.isBusy());
  }

  async getStats(): Promise<EngineStats> {
    return this.guarded((api) => api.getStats());
  }

  async ensureLoaded(
    modelId: string,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<LoadResult> {
    this.touch();
    return this.guarded(async (api) => {
      const stats = await api.getStats();
      if (stats.modelId !== null && stats.loadedAt !== null) {
        return { loadMs: 0, device: stats.device };
      }
      const opts: LoadOptions = this.degradeToWasm ? { device: 'wasm' } : {};
      return api.loadEngine(modelId, proxy(onProgress), opts);
    });
  }

  async downloadModel(
    modelId: string,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<{ bytes: number; downloaded: number }> {
    this.touch();
    try {
      return await this.guarded((api) => api.downloadModel(modelId, proxy(onProgress)));
    } catch (err) {
      throw this.typedError(err);
    }
  }

  async cancelDownload(): Promise<void> {
    if (!this.api) return;
    await this.api.cancelDownload().catch(() => undefined);
  }

  async ocrPage(
    image: RasterImageData,
    onToken: (chunk: string) => void,
    opts?: OcrPageOptions,
  ): Promise<AiOcrPageResult> {
    this.touch();
    try {
      return await this.guarded((api) => api.ocrPage(image, proxy(onToken), opts));
    } catch (err) {
      throw this.typedError(err);
    }
  }

  async getDownloadInfo(modelId: string): Promise<DownloadInfo> {
    this.touch();
    return this.guarded((api) => api.getDownloadInfo(modelId));
  }

  async isCached(modelId: string): Promise<boolean> {
    this.touch();
    return this.guarded((api) => api.isCached(modelId));
  }

  async clearCache(modelId: string): Promise<number> {
    this.touch();
    return this.guarded((api) => api.clearCache(modelId));
  }

  /** Terminate the worker and stop timers (page teardown). */
  destroy(): void {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    if (this.hiddenTimer !== null) window.clearTimeout(this.hiddenTimer);
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
    this.api = null;
  }
}

/*
 * Shared client: the OCR tool, Settings (phase 5) and any future caller
 * must drive ONE worker — a second spawn would double engine memory.
 */
let shared: AiWorkerClient | null = null;

export function sharedAiClient(options: AiClientOptions = {}): AiWorkerClient {
  if (!shared) shared = new AiWorkerClient(options);
  return shared;
}
