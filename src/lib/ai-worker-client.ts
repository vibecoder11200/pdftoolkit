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
import { probeAdapters, resolveChoice, getGpuChoice, type AdapterDiscovery, type ResolvedGpuChoice } from './gpu-choice';
import { setGpuFallback } from './gpu-fallback-store';
import { hasActiveJob } from './jobs';


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

/** applyGpuChoice while a job runs — the UI disables the button via the same
 *  job registry; this guards the race and carries the honest message. */
export class EngineBusyError extends Error {
  constructor() {
    super('AI engine is running — apply is disabled until the job finishes.');
    this.name = 'EngineBusyError';
  }
}

const GPU_LOST_MESSAGE = 'WebGPU device was lost';

/**
 * Message-based GPU-failure classification (never instanceof — comlink
 * crosses the boundary message-only, cf. ai-run.ts): covers ALL R1 Q4
 * shapes — probe-null, Dawn adapter/device create failures, the ORT
 * concurrency guard, backend-poison init errors, and device loss (both the
 * worker's GpuLostError phrasing and ORT's native "WebGPU device lost").
 */
const WEBGPU_LOST_RE = /webgpu device (was )?lost|device lost|lost the device|destroying a gpu/i;
const WEBGPU_INIT_FAIL_RE =
  /failed to get a webgpu (adapter|device)|webgpu is not supported|no available adapters|another webgpu ep inference session/i;

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
  /** Fallback-chain notifications (phase 2) — also mirrored into the
   *  gpu-fallback-store; this callback is for direct callers (tests). */
  onGpuFallback?: (info: { from: string; to: string; reason: string }) => void;
  /** Injectable choice resolution — defaults to the phase-1 store + a live
   *  dual probe; node tests inject a stub (no navigator.gpu there). */
  resolveGpuRequest?: () => Promise<ResolvedGpuChoice | null>;
  /** Injectable discovery for the hop decision (same node-test rationale). */
  probeAdapters?: () => Promise<AdapterDiscovery>;
}

interface PendingCall {
  reject: (err: unknown) => void;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_HIDDEN_MS = 5 * 60_000;
/** handleFatal spawn budget (see handleFatal — offline first-use otherwise
 * loops spawn/fail forever; a settled guarded() call resets the counter). */
const MAX_RESTARTS = 5;
/**
 * RED-TEAM H4: GPU-hop cap — deliberately NOT derived from `restarts`
 * (guarded() resets restarts on every settled non-crash rejection, which
 * would neutralize MAX_RESTARTS into an infinite spawn/fail cycle when both
 * adapters fail). One hop (chosen → other GPU); the next failure degrades
 * to wasm in place. Reset ONLY by user-initiated applyGpuChoice.
 */
const MAX_GPU_HOPS = 1;

/** Default request resolution: the persisted choice, probed live. */
async function defaultResolveGpuRequest(): Promise<ResolvedGpuChoice | null> {
  const choice = getGpuChoice();
  if (choice !== 'auto' && choice.kind === 'cpu') return { kind: 'cpu' };
  const discovery = await probeAdapters();
  // No adapters discoverable: pass nothing — the engine's own bare request
  // becomes the honest probe and the fallback chain handles the failure.
  if (discovery.adapters.length === 0) return null;
  return resolveChoice(choice, discovery).resolved;
}

export class AiWorkerClient {
  private readonly options: AiClientOptions;
  private worker: Worker | null = null;
  private api: Remote<AiOcrApi> | null = null;
  private pending = new Set<PendingCall>();
  private restarts = 0;
  private degradeToWasm = false;
  /** RED-TEAM H3/H2: recovery pins — a GPU hop pins the other adapter's
   *  slot until the first successful post-hop load; applyGpuChoice clears
   *  both pins (user choice outranks). */
  private pinPowerPreference: 'high-performance' | 'low-power' | undefined = undefined;
  private gpuHopCount = 0;
  /** RED-TEAM H6: one-shot override (per-adapter measurement) — consumed by
   *  the next ensureLoaded; the PERSISTED choice is never temp-written. */
  private loadOverride: ResolvedGpuChoice | null = null;
  /** The preference slot the RUNNING engine was loaded with — the hop
   *  decision compares the failed slot against discovery (a collapsed
   *  single-adapter machine never hops). */
  private activeRequestPref: 'high-performance' | 'low-power' | undefined = undefined;
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

  /**
   * Deliberate respawn for an adapter switch (red-team H4/A4): terminate +
   * spawn WITHOUT touching the crash budget (`restarts`), rejecting pending
   * calls so nothing strands. The next load runs pinned via
   * pinPowerPreference (ensureLoaded precedence).
   */
  private respawnDeliberate(): void {
    const pending = [...this.pending];
    this.pending.clear();
    for (const p of pending) p.reject(new WorkerCrashError(new Error('switching GPU adapter')));
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
    this.api = null;
    this.spawn();
  }

  /**
   * GPU-failure chain (phase 2): dGPU→iGPU→CPU. One deliberate hop to the
   * OTHER adapter's slot — only when a genuinely different, non-software
   * adapter exists (Windows collapse = no hop, straight to wasm) — else
   * in-place wasm degrade (R1: CPU retry works after webgpu poison; webgpu
   * retry in the same context never does).
   */
  private async classifyGpuFailure(err: unknown, message: string): Promise<unknown> {
    const lost = WEBGPU_LOST_RE.test(message);
    if (!lost && !WEBGPU_INIT_FAIL_RE.test(message)) return err;
    if (this.gpuHopCount < MAX_GPU_HOPS) {
      const probe = this.options.probeAdapters ?? probeAdapters;
      // A probe failure must never mask the GPU failure that brought us
      // here — treat it as "nothing discoverable" (straight to wasm).
      let discovery: AdapterDiscovery;
      try {
        discovery = await probe();
      } catch {
        discovery = { adapters: [], probes: { hp: null, lp: null } };
      }
      const { hp, lp } = discovery.probes;
      // The adapter the engine was actually USING (bare request ≈ the
      // default/high-performance slot — Dawn maps bare to the same
      // enumeration). A candidate equal to it is a cosmetic hop.
      const usedFp =
        this.activeRequestPref === 'low-power'
          ? lp?.fingerprint
          : this.activeRequestPref === 'high-performance'
            ? hp?.fingerprint
            : (hp?.fingerprint ?? lp?.fingerprint);
      const candidates: Array<'high-performance' | 'low-power'> =
        this.activeRequestPref === 'high-performance'
          ? ['low-power']
          : this.activeRequestPref === 'low-power'
            ? ['high-performance']
            : ['low-power', 'high-performance'];
      for (const pref of candidates) {
        const probeSlot = pref === 'high-performance' ? hp : lp;
        if (!probeSlot || probeSlot.isFallbackAdapter === true) continue;
        if (usedFp !== undefined && probeSlot.fingerprint === usedFp) continue;
        this.gpuHopCount += 1;
        this.pinPowerPreference = pref;
        const info = { from: usedFp ?? 'unknown', to: probeSlot.fingerprint, reason: message };
        setGpuFallback({ ...info, at: Date.now() });
        this.options.onGpuFallback?.(info);
        this.respawnDeliberate();
        return new GpuLostError();
      }
    }
    // No hop available: wasm degrade in place. Device loss also needs the
    // standard fatal respawn (the worker may be dead); init-fail poisons
    // only the webgpu backend — wasm still works in that context.
    this.degradeToWasm = true;
    setGpuFallback({ from: this.activeRequestPref ?? 'gpu', to: 'cpu', reason: message, at: Date.now() });
    this.options.onGpuFallback?.({ from: this.activeRequestPref ?? 'gpu', to: 'cpu', reason: message });
    if (lost) {
      this.handleFatal(err);
      this.options.onGpuLost?.();
      return new GpuLostError();
    }
    return err;
  }

  /** Async classification used by the delegated calls (chain + notifications). */
  private async typedErrorAsync(err: unknown): Promise<unknown> {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(GPU_LOST_MESSAGE) || WEBGPU_LOST_RE.test(message) || WEBGPU_INIT_FAIL_RE.test(message)) {
      return this.classifyGpuFailure(err, message);
    }
    return err;
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

  /**
   * User-initiated choice application (phase 2). Idle → dispose (R1: full
   * session release re-arms the EP context, so the next ensureLoaded builds
   * its device from the NEW choice) — no worker respawn, no app restart.
   * RED-TEAM H5: gated on the JOB REGISTRY (hasActiveJob), not isBusy() —
   * stats.busy is only true INSIDE worker run(); between OCR pages the
   * worker idles while the main thread renders, so an isBusy() gate could
   * dispose mid-run with no resume offer. A second (worker-side) busy check
   * backs the registry up.
   * RED-TEAM H6: an explicit `override` (per-adapter measurement) is a ONE-
   * SHOT request — the persisted choice is never temp-written; a failed
   * measurement cannot strand the user's selection. After the measurement,
   * callers re-apply the persisted choice (applyGpuChoice() bare).
   */
  async applyGpuChoice(override?: ResolvedGpuChoice): Promise<void> {
    // Gate FIRST (both the registry and the worker-side busy check) — a
    // rejected apply must not leave pins cleared or an override armed.
    if (hasActiveJob()) throw new EngineBusyError();
    const api = this.api;
    if (api) {
      const busy = await api.isBusy().catch(() => true);
      if (busy) throw new EngineBusyError();
    }
    this.degradeToWasm = false;
    this.pinPowerPreference = undefined;
    this.gpuHopCount = 0;
    this.loadOverride = override ?? null;
    if (api) await api.dispose().catch(() => undefined);
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

  /**
   * The request the NEXT load would carry (choice + pins + degrade) — the
   * status line's honest "requesting X" basis. `degraded` distinguishes a
   * wasm request born from the fallback chain vs a user CPU choice.
   */
  async effectiveRequest(): Promise<
    { device: 'wasm'; degraded: boolean; fingerprint: null } | { device: 'webgpu'; degraded: false; powerPreference?: 'high-performance' | 'low-power'; fingerprint: string | null }
  > {
    if (this.degradeToWasm) return { device: 'wasm', degraded: true, fingerprint: null };
    const override = this.loadOverride;
    if (override) {
      return override.kind === 'cpu'
        ? { device: 'wasm', degraded: false, fingerprint: null }
        : { device: 'webgpu', degraded: false, powerPreference: override.powerPreference, fingerprint: override.fingerprint };
    }
    if (this.pinPowerPreference) {
      return { device: 'webgpu', degraded: false, powerPreference: this.pinPowerPreference, fingerprint: null };
    }
    const request = (this.options.resolveGpuRequest ?? defaultResolveGpuRequest)();
    const resolved = request instanceof Promise ? await request : request;
    if (resolved?.kind === 'cpu') return { device: 'wasm', degraded: false, fingerprint: null };
    if (resolved?.kind === 'gpu') {
      return { device: 'webgpu', degraded: false, powerPreference: resolved.powerPreference, fingerprint: resolved.fingerprint };
    }
    return { device: 'webgpu', degraded: false, fingerprint: null };
  }

  async ensureLoaded(
    modelId: string,
    onProgress: (p: DownloadProgress) => void,
    loadOpts?: { override?: ResolvedGpuChoice },
  ): Promise<LoadResult> {
    this.touch();
    // RED-TEAM C1: load-time failures MUST reach the classifier (hop /
    // degrade / notify) — raw rejections used to leave the poisoned worker
    // alive with no notification.
    try {
      // One-shot override (H6): an explicit loadOpts override wins, else a
      // pending applyGpuChoice(override) is consumed here.
      const override = loadOpts?.override ?? this.loadOverride;
      let request: ResolvedGpuChoice | null;
      if (override) {
        request = override;
      } else {
        const r = (this.options.resolveGpuRequest ?? defaultResolveGpuRequest)();
        request = r instanceof Promise ? await r : r;
      }
      const result = await this.guarded(async (api) => {
        const stats = await api.getStats();
        if (stats.modelId !== null && stats.loadedAt !== null) {
          return { loadMs: 0, device: stats.device, adapterFingerprint: stats.adapterFingerprint };
        }
        // Precedence (red-team H3/H2): crash-budget degrade > recovery pin >
        // the user's choice. applyGpuChoice clears both pins; a pin also
        // clears itself after the first successful load.
        const opts: LoadOptions = {};
        if (this.degradeToWasm) {
          opts.device = 'wasm';
        } else {
          if (request?.kind === 'cpu') opts.device = 'wasm';
          else if (this.pinPowerPreference) opts.powerPreference = this.pinPowerPreference;
          else if (request?.kind === 'gpu') opts.powerPreference = request.powerPreference;
        }
        this.activeRequestPref = opts.powerPreference;
        return api.loadEngine(modelId, proxy(onProgress), opts);
      });
      this.loadOverride = null; // one-shot consumed
      this.pinPowerPreference = undefined; // survived until the first success
      return result;
    } catch (err) {
      throw await this.typedErrorAsync(err);
    }
  }

  async downloadModel(
    modelId: string,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<{ bytes: number; downloaded: number }> {
    this.touch();
    try {
      return await this.guarded((api) => api.downloadModel(modelId, proxy(onProgress)));
    } catch (err) {
      throw await this.typedErrorAsync(err);
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
      throw await this.typedErrorAsync(err);
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
