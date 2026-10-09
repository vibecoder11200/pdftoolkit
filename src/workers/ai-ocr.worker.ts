import { expose } from 'comlink';
import {
  AI_CACHE_STORE,
  AI_MODEL_ID,
  getModelSpec,
  hfFileUrl,
  pipelineOptions,
  sameOriginWasmPaths,
  type AiModelSpec,
} from '../lib/ai-models';
import {
  clearModelCache,
  ensureModelDownloaded,
  isCacheUsable,
  type CacheLike,
} from '../lib/ai-download';
import type { DownloadProgress } from '../lib/ai-models';
import type { RasterImageData } from './pdf.worker';
import { adapterFingerprint, readAdapterInfo } from '../lib/capability';

/*
 * AI OCR worker (v0.5.0 phase 2b, F2/F6/F8/F11/F12). URL module worker —
 * NEVER a blob (a blob worker inherits page CSP and defeats the model-fetch
 * seam; AGENTS.md invariant). EVERY transformers.js call lives here — the
 * main thread never imports the library (F11: megabytes stay out of the
 * entry bundle) and every model network call happens in this scope.
 *
 * Mock seam (F8): when the client spawns this worker with name 'ai-mock'
 * (selected by the PAGE URL `?ai-mock=1` flag), the same comlink API
 * is served by a canned deterministic engine — zero network, zero
 * transformers import, fake download progress. CI drives the REAL worker
 * chunk through this seam (self.name checked HERE, not an env build flag),
 * and the zero-external fence stays unconditional.
 *
 * Session lifecycle (F6): one engine per worker; `busy` guards dispose
 * against in-flight jobs (the main-side wrapper owns the idle/visibility
 * timers and re-arms while busy). A fatal worker error is the main-side
 * wrapper's restart trigger; results are page-indexed so the tool can offer
 * resume from the last completed page. After a GPU-device-loss the wrapper
 * restarts the worker with device 'wasm' (the degrade path).
 */

type Transformers = typeof import('@huggingface/transformers');

/** Mock seam flag (F8): the client spawns the worker with name 'ai-mock'. */
export const AI_MOCK_NAME = 'ai-mock';

export interface AiOcrPageResult {
  /** Raw engine output (markdown-ish text), one page. */
  text: string;
  ms: number;
  genTokens: number;
  tokPerSec: number;
  firstTokenMs: number | null;
}

export interface EngineStats {
  modelId: string | null;
  device: 'webgpu' | 'wasm' | 'mock';
  busy: boolean;
  loadedAt: number | null;
  /** The adapter the ENGINE built its device from (null on wasm/mock) —
   *  honest-reporting basis: diagnostics show the REQUEST and this REPORT
   *  side by side; they can legally differ (Windows override). */
  adapterFingerprint: string | null;
}

export interface LoadResult {
  loadMs: number;
  device: EngineStats['device'];
  adapterFingerprint: string | null;
}

export interface DownloadInfo {
  cached: boolean;
  filesCached: number;
  filesTotal: number;
  totalBytes: number;
}

export interface LoadOptions {
  /** Force the WASM CPU tier (GPU-lost degrade — F6). */
  device?: 'webgpu' | 'wasm';
  /** Adapter-selection slot for the GPU device WE request and inject into
   *  the ORT session (R1: env.webgpu.powerPreference is dead in the Dawn
   *  build — the injected device is the only reliable selector). Absent =
   *  bare request (the discovery slot that found the adapter decides). */
  powerPreference?: 'high-performance' | 'low-power';
}

export interface OcrPageOptions {
  /** Cap generation (benchmark passes use small values for determinism). */
  maxNewTokens?: number;
  /** Image long-edge cap for THIS run (phase 3 preflight tuning: the
   *  reduced preset is 768). Absent = the SPIKE-measured 1024 default —
   *  existing callers are unchanged. */
  maxLongEdge?: number;
}

export interface AiOcrApi {
  isBusy(): Promise<boolean>;
  loadEngine(
    modelId: string,
    onProgress: (p: DownloadProgress) => void,
    opts?: LoadOptions,
  ): Promise<LoadResult>;
  downloadModel(
    modelId: string,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<{ bytes: number; downloaded: number }>;
  cancelDownload(): Promise<void>;
  ocrPage(
    image: RasterImageData,
    onToken: (chunk: string) => void,
    opts?: OcrPageOptions,
  ): Promise<AiOcrPageResult>;
  getStats(): Promise<EngineStats>;
  dispose(): Promise<void>;
  /** Cache state (manifest ∩ store + verified marker), worker-side only. */
  getDownloadInfo(modelId: string): Promise<DownloadInfo>;
  isCached(modelId: string): Promise<boolean>;
  clearCache(modelId: string): Promise<number>;
}

type ComlinkCallback<T extends unknown> = (p: T) => void;

interface EngineLike {
  readonly stats: EngineStats;
  load(onProgress: ComlinkCallback<DownloadProgress>, opts?: LoadOptions): Promise<LoadResult>;
  download(onProgress: ComlinkCallback<DownloadProgress>): Promise<{ bytes: number; downloaded: number }>;
  cancelDownload(): void;
  run(
    image: RasterImageData,
    onToken: ComlinkCallback<string>,
    opts?: OcrPageOptions,
  ): Promise<AiOcrPageResult>;
  dispose(): Promise<void>;
  downloadInfo(): Promise<DownloadInfo>;
  isCached(): Promise<boolean>;
  clearCache(): Promise<number>;
}

/* ------------------------------ mock engine ------------------------------ */

const MOCK_MARKDOWN = [
  '# BÁO CÁO TỒN KHO QUÝ 3/2026',
  '',
  '## Khu vực phía Bắc',
  '',
  '| Mã hàng | Thành tiền (VND) |',
  '| --- | --- |',
  '| BT-031 | 12.450.000 |',
  '| BT-032 | 149.450.000 |',
  '| BT-033 | 286.450.000 |',
  '',
  '## Khu vực phía Nam',
  '',
  '| Mã hàng | Thành tiền (VND) |',
  '| --- | --- |',
  '| SG-007 | 8.320.000 |',
  '| SG-008 | 145.320.000 |',
  '',
  'Ghi chú: <script>alert(1)</script> và <img src=x onerror=alert(2)>',
  '[click](javascript:alert(3))',
].join('\n');

/**
 * Canned deterministic engine (F8): same comlink API shape, fake progress,
 * zero network, zero transformers import. CI runs this in the real worker
 * chunk; the contract spec pins both engines to the same API shape.
 */
/** Exported for the contract spec — pinned to the same API shape as RealEngine. */
export class MockEngine implements EngineLike {
  readonly stats: EngineStats = {
    modelId: 'mock',
    device: 'mock',
    busy: false,
    loadedAt: null,
    adapterFingerprint: null,
  };
  private downloadAbort = false;

  async load(onProgress: ComlinkCallback<DownloadProgress>): Promise<LoadResult> {
    // Cancel must not be permanent (review P2-10): a reset happens at every
    // load, so cancelDownload only ever kills the load in flight.
    this.downloadAbort = false;
    const t0 = Date.now();
    this.stats.busy = true;
    try {
      for (let i = 1; i <= 10; i++) {
        if (this.downloadAbort) throw new DOMException('aborted', 'AbortError');
        await new Promise((r) => setTimeout(r, 20));
        onProgress({
          phase: 'downloading',
          file: `mock-shard-${i}`,
          loaded: i * 65_200_000,
          total: 652_000_000,
          percent: i * 10,
        });
      }
      this.stats.loadedAt = Date.now();
      return { loadMs: Date.now() - t0, device: 'mock', adapterFingerprint: null };
    } finally {
      this.stats.busy = false;
    }
  }

  async download(onProgress: ComlinkCallback<DownloadProgress>): Promise<{ bytes: number; downloaded: number }> {
    await this.load(onProgress);
    return { bytes: 652_000_000, downloaded: 652_000_000 };
  }

  cancelDownload(): void {
    this.downloadAbort = true;
  }

  async run(
    image: RasterImageData,
    onToken: ComlinkCallback<string>,
    opts?: OcrPageOptions,
  ): Promise<AiOcrPageResult> {
    void image;
    void opts;
    this.stats.busy = true;
    try {
      await new Promise((r) => setTimeout(r, 30));
      for (const line of MOCK_MARKDOWN.split('\n')) onToken(`${line}\n`);
      return {
        text: MOCK_MARKDOWN,
        ms: 30,
        genTokens: MOCK_MARKDOWN.split('\n').length,
        tokPerSec: 0,
        firstTokenMs: 1,
      };
    } finally {
      this.stats.busy = false;
    }
  }

  async dispose(): Promise<void> {
    if (this.stats.busy) throw new Error('dispose() called while a job is active');
    this.stats.loadedAt = null;
  }

  async downloadInfo(): Promise<DownloadInfo> {
    return {
      cached: this.stats.loadedAt !== null,
      filesCached: 0,
      filesTotal: 0,
      totalBytes: 652_000_000,
    };
  }

  async isCached(): Promise<boolean> {
    return (await this.downloadInfo()).cached;
  }

  async clearCache(): Promise<number> {
    this.stats.loadedAt = null;
    return 0;
  }
}

/* ------------------------------ real engine ------------------------------ */

/**
 * transformers' env.customCache adapter over OUR store. Files are stored
 * CHUNKED (MODEL_CHUNK_BYTES parts — whole-file puts of the 321MB shard
 * die in dedicated workers), so match() reassembles the `::part/i` run
 * into one Response before transformers reads it. transformers only ever
 * READS here (downloads happen via ensureModelDownloaded first); put and
 * delete pass through for completeness.
 */
class OwnedCacheAdapter {
  constructor(private store: Cache) {}
  match = async (key: string) => {
    const direct = await this.store.match(key);
    if (direct) return direct;
    const parts: ArrayBuffer[] = [];
    for (let i = 0; ; i += 1) {
      const res = await this.store.match(`${key}::part/${i}`);
      if (!res) break;
      parts.push(await res.arrayBuffer());
    }
    if (parts.length === 0) return undefined;
    const total = parts.reduce((s, p) => s + p.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      joined.set(new Uint8Array(p), offset);
      offset += p.byteLength;
    }
    return new Response(joined);
  };
  put = (key: string, res: Response) => this.store.put(key, res);
  delete = async (key: string) => {
    let deleted = await this.store.delete(key);
    for (let i = 0; ; i += 1) {
      if (!(await this.store.delete(`${key}::part/${i}`))) break;
      deleted = true;
    }
    return deleted;
  };
}

export class GpuLostError extends Error {
  constructor(cause: unknown) {
    super('WebGPU device was lost during inference.', { cause });
    this.name = 'GpuLostError';
  }
}

/**
 * The requested adapter could not be obtained at LOAD time (probe null,
 * requestDevice failure, navigator.gpu gone). Message-shaped for the
 * client-side classifier — comlink crosses the boundary message-only, so
 * the name never survives; the message must match the R1 Q4 init-failure
 * shapes for the dGPU→iGPU→CPU chain to fire.
 */
export class AdapterUnavailableError extends Error {
  constructor(powerPreference: 'high-performance' | 'low-power' | undefined, reason: string) {
    super(
      `Failed to get a WebGPU adapter${powerPreference ? ` (${powerPreference})` : ''}: ${reason}`,
      { cause: reason },
    );
    this.name = 'AdapterUnavailableError';
  }
}

const GPU_LOST_PATTERN = /device lost|GPUDevice|lost the device|Destroying a GPU/i;

const OCR_PROMPT =
  'Convert this document page to markdown. Preserve headings and tables. Keep Vietnamese diacritics.';

/**
 * SPIKE-measured engine contract: pages are capped at a 1024px long edge
 * before inference. 1280px gained nothing measurable and cost ~+700MB peak
 * RAM; 1024 kept every fixture number/table cell correct.
 */
const MAX_LONG_EDGE = 1024;

/**
 * Pure resize math for the long-edge cap (phase 3 preflight tuning) —
 * extracted so the reduced-preset behavior is unit-testable without WebGL.
 * Returns null when no downscale is needed.
 */
export function longEdgeScale(
  width: number,
  height: number,
  cap: number,
): { width: number; height: number } | null {
  const longEdge = Math.max(width, height);
  if (longEdge <= cap) return null;
  const scale = cap / longEdge;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export class RealEngine implements EngineLike {
  stats: EngineStats = { modelId: null, device: 'webgpu', busy: false, loadedAt: null, adapterFingerprint: null };
  private spec: AiModelSpec = getModelSpec(AI_MODEL_ID);
  private T: Transformers | null = null;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private processor: any = null;
  private tokenizer: any = null;
  private model: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  private downloadController: AbortController | null = null;
  /** In-flight first load — concurrent callers share it instead of double-loading GB-scale shards (review P2-9). */
  private loadInFlight: Promise<LoadResult> | null = null;
  /** DI for node-side tests (the worker probes navigator.gpu inside its own global). */
  private readonly gpu: Navigator['gpu'] | undefined;
  /** The device WE created for the injected sessions — released on dispose. */
  private ownedDevice: GPUDevice | null = null;

  constructor(gpu?: Navigator['gpu'] | undefined) {
    this.gpu =
      gpu ?? (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { gpu?: Navigator['gpu'] }).gpu);
  }

  private async importTransformers(): Promise<Transformers> {
    const T = await import('@huggingface/transformers');
    // F1 pin: the ORT wasm factory loads from the same-origin copies in
    // public/ort/ — never from the transformers.js jsDelivr default.
    T.env.allowLocalModels = false;
    T.env.useBrowserCache = false;
    T.env.useCustomCache = true;
    T.env.customCache = new OwnedCacheAdapter(await caches.open(AI_CACHE_STORE));
    if (T.env.backends.onnx.wasm) {
      T.env.backends.onnx.wasm.wasmPaths = sameOriginWasmPaths(import.meta.env.BASE_URL);
    }
    return T;
  }

  async load(onProgress: ComlinkCallback<DownloadProgress>, opts?: LoadOptions): Promise<LoadResult> {
    if (this.model) {
      return { loadMs: 0, device: this.stats.device, adapterFingerprint: this.stats.adapterFingerprint };
    }
    // Two concurrent first loads (OCR tool + Settings re-measure) would each
    // fetch the model and orphan one copy — dedupe on the in-flight promise.
    if (this.loadInFlight) return this.loadInFlight;
    this.loadInFlight = this.doLoad(onProgress, opts);
    try {
      return await this.loadInFlight;
    } finally {
      this.loadInFlight = null;
    }
  }

  private async doLoad(
    onProgress: ComlinkCallback<DownloadProgress>,
    opts?: LoadOptions,
  ): Promise<LoadResult> {
    if (opts?.device) this.stats.device = opts.device;
    this.stats.busy = true;
    const t0 = Date.now();
    try {
      onProgress({ phase: 'downloading', percent: null });
      const T = await this.importTransformers();
      this.T = T;
      const o = pipelineOptions(this.spec.id);
      // R1: the ORT Dawn EP pins its GPUDevice per worker-context and
      // ignores env.webgpu.powerPreference — the only reliable adapter
      // selector is a device WE request and inject per session
      // (webgpuRegisterDevice, ORT ≥ 1.25).
      let injectedDevice: GPUDevice | null = null;
      let fingerprint: string | null = null;
      if (this.stats.device === 'webgpu') {
        if (!this.gpu) throw new AdapterUnavailableError(opts?.powerPreference, 'navigator.gpu missing in worker');
        let adapter: GPUAdapter | null = null;
        try {
          adapter = await this.gpu.requestAdapter(
            opts?.powerPreference ? { powerPreference: opts.powerPreference } : undefined,
          );
        } catch (err) {
          throw new AdapterUnavailableError(opts?.powerPreference, String(err instanceof Error ? err.message : err));
        }
        if (!adapter) throw new AdapterUnavailableError(opts?.powerPreference, 'requestAdapter returned null');
        try {
          // SPIKE-PROVEN (2026-10-09, this machine): a bare requestDevice()
          // yields a device WITHOUT optional features — q4f16 session create
          // then dies with "Program Transpose requires f16 but the device
          // does not support it". ORT's own device requests shader-f16; the
          // injected device must too.
          injectedDevice = await adapter.requestDevice({
            requiredFeatures: adapter.features?.has('shader-f16') ? ['shader-f16'] : [],
          });
        } catch (err) {
          throw new AdapterUnavailableError(opts?.powerPreference, String(err instanceof Error ? err.message : err));
        }
        this.ownedDevice = injectedDevice;
        fingerprint = adapterFingerprint(readAdapterInfo(adapter));
      }
      const loadOpts = {
        revision: o.revision,
        dtype: { ...o.dtype },
        device: this.stats.device as 'webgpu' | 'wasm',
        use_external_data_format: o.use_external_data_format,
        ...(injectedDevice
          ? { session_options: { executionProviders: [{ name: 'webgpu', device: injectedDevice }] } }
          : {}),
      };
      this.processor = await T.AutoProcessor.from_pretrained(this.spec.repo, {
        revision: o.revision,
      });
      this.tokenizer = await T.AutoTokenizer.from_pretrained(this.spec.repo, {
        revision: o.revision,
      });
      this.model = await T.AutoModelForImageTextToText.from_pretrained(this.spec.repo, loadOpts);
      this.stats.modelId = this.spec.id;
      this.stats.loadedAt = Date.now();
      this.stats.adapterFingerprint = fingerprint;
      onProgress({ phase: 'done', percent: 100 });
      return { loadMs: Date.now() - t0, device: this.stats.device, adapterFingerprint: fingerprint };
    } finally {
      this.stats.busy = false;
    }
  }

  async download(onProgress: ComlinkCallback<DownloadProgress>): Promise<{ bytes: number; downloaded: number }> {
    this.stats.busy = true;
    this.downloadController = new AbortController();
    try {
      const store = (await caches.open(AI_CACHE_STORE)) as unknown as CacheLike;
      return await ensureModelDownloaded(this.spec, this.downloadController.signal, {
        fetchImpl: (url, init) => fetch(url, init),
        cacheStore: store,
        storage: navigator.storage,
        onProgress,
      });
    } finally {
      this.downloadController = null;
      this.stats.busy = false;
    }
  }

  cancelDownload(): void {
    this.downloadController?.abort();
  }

  async run(
    image: RasterImageData,
    onToken: ComlinkCallback<string>,
    opts?: OcrPageOptions,
  ): Promise<AiOcrPageResult> {
    if (!this.T || !this.model) throw new Error('Engine not loaded — call loadEngine first.');
    this.stats.busy = true;
    try {
      const { TextStreamer, RawImage } = this.T;
      let rawImage = new RawImage(image.data, image.width, image.height, 4);
      const scaled = longEdgeScale(rawImage.width, rawImage.height, opts?.maxLongEdge ?? MAX_LONG_EDGE);
      if (scaled) {
        rawImage = await rawImage.resize(scaled.width, scaled.height);
      }
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'image', image: rawImage },
            { type: 'text', text: OCR_PROMPT },
          ],
        },
      ];
      const prompt = this.tokenizer.apply_chat_template(messages, {
        add_generation_prompt: true,
        tokenize: false,
      });
      const t0 = performance.now();
      const inputs = await this.processor(prompt, [rawImage]);
      let firstTokenMs: number | null = null;
      const tGen0 = performance.now();
      const streamer = new TextStreamer(this.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (chunk: string) => {
          if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - tGen0);
          onToken(chunk);
        },
      });
      const out = await this.model.generate({
        ...inputs,
        max_new_tokens: opts?.maxNewTokens ?? 4096,
        do_sample: false,
        num_logits_to_keep: 1, // SPIKE: full-sequence logits over the 152k vocab ballooned RAM (~8GB); last-position only keeps generation bounded
        streamer,
      });
      const genMs = Math.round(performance.now() - tGen0);
      const inLen = inputs.input_ids.dims ? inputs.input_ids.dims.at(-1) : inputs.input_ids.length;
      const outLen = out.dims ? out.dims.at(-1) : out.length;
      // decode ONLY the generated tail (SPIKE-proven path): the full
      // sequence re-echoes the prompt's image-placeholder tokens, and
      // batch_decode over the whole tensor returns '' under
      // skip_special_tokens — the v0.5.0 hand-test found the empty output.
      const flat = Array.from(out.data, Number);
      const decoded = this.tokenizer.decode(flat.slice(inLen), { skip_special_tokens: true });
      return {
        text: decoded,
        ms: Math.round(performance.now() - t0),
        genTokens: outLen - inLen,
        tokPerSec: +((outLen - inLen) / (genMs / 1000)).toFixed(2),
        firstTokenMs,
      };
    } catch (err) {
      if (err instanceof Error && GPU_LOST_PATTERN.test(err.message)) throw new GpuLostError(err);
      throw err;
    } finally {
      this.stats.busy = false;
    }
  }

  async dispose(): Promise<void> {
    // Review P2-5: disposing under an in-flight job orphaned the session.
    // Fails loud — the client-side idle/hidden paths already check stats.busy
    // and never call dispose while a job runs, so reaching this means a
    // caller is misusing the session.
    if (this.stats.busy) throw new Error('dispose() called while a job is active');
    this.stats.busy = false;
    // R1 Q5: EVERY webgpu session must release so the EP factory ref-count
    // hits zero and the context erases — the next create re-requests the
    // adapter (this is what makes adapter switching work without a worker
    // respawn). Only the model session was released before phases 1-3.
    for (const piece of [this.model, this.processor, this.tokenizer]) {
      try {
        await piece?.dispose?.();
      } catch {
        /* dispose on a dead session is best-effort */
      }
    }
    try {
      this.ownedDevice?.destroy?.();
    } catch {
      /* a lost device cannot be destroyed again */
    }
    this.ownedDevice = null;
    this.model = null;
    this.processor = null;
    this.tokenizer = null;
    this.stats.modelId = null;
    this.stats.loadedAt = null;
    this.stats.adapterFingerprint = null;
  }

  /**
   * File list straight from the pinned manifest (spec.files) — NOT
   * ModelRegistry.get_pipeline_files: that validates the task against the
   * PIPELINE list, and 'image-text-to-text' is a class-route task with no
   * pipeline entry, so it throws "Unsupported pipeline task" before a byte
   * is downloaded (the class route is the only supported way to run this
   * model — see the SPIKE report). Also drops the transformers import from
   * the state-check path entirely.
   */
  async downloadInfo(): Promise<DownloadInfo> {
    const store = (await caches.open(AI_CACHE_STORE)) as unknown as CacheLike;
    let filesCached = 0;
    for (const f of this.spec.files) {
      if (await store.match(hfFileUrl(this.spec, f.path))) filesCached += 1;
    }
    return {
      // isCacheUsable: complete AND marker-verified — a full-but-unverified
      // set (interrupted verify) flows into ensureModelDownloaded, which
      // re-hashes with zero network instead of being loaded unverified.
      cached: await isCacheUsable(
        this.spec,
        store,
        filesCached,
        this.spec.files.length,
      ),
      filesCached,
      filesTotal: this.spec.files.length,
      totalBytes: this.spec.totalBytes,
    };
  }

  async isCached(): Promise<boolean> {
    const info = await this.downloadInfo();
    return info.cached;
  }

  async clearCache(): Promise<number> {
    const store = (await caches.open(AI_CACHE_STORE)) as unknown as CacheLike;
    return clearModelCache(this.spec, store);
  }
}

/* ------------------------------- comlink api ------------------------------ */

/** Node-safe boot (contract spec imports this module): no `self.name` there. */
const isMock =
  typeof self !== 'undefined' && (self as { name?: string }).name === AI_MOCK_NAME;
const engine: EngineLike = isMock ? new MockEngine() : new RealEngine();

const api: AiOcrApi = {
  isBusy: async () => engine.stats.busy,
  loadEngine: (modelId, onProgress, opts) => {
    void modelId;
    return engine.load(onProgress, opts);
  },
  downloadModel: (modelId, onProgress) => {
    void modelId;
    return engine.download(onProgress);
  },
  cancelDownload: async () => engine.cancelDownload(),
  ocrPage: (image, onToken, opts) => engine.run(image, onToken, opts),
  getStats: async () => engine.stats,
  dispose: () => engine.dispose(),
  getDownloadInfo: (modelId) => {
    void modelId;
    return engine.downloadInfo();
  },
  isCached: (modelId) => {
    void modelId;
    return engine.isCached();
  },
  clearCache: (modelId) => {
    void modelId;
    return engine.clearCache();
  },
};

// Comlink needs an endpoint — only a real worker scope has one. Node-side
// imports (contract spec) use the exported classes directly.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  expose(api);
}
