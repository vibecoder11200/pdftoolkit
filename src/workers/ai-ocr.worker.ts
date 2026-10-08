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
}

export interface LoadResult {
  loadMs: number;
  device: EngineStats['device'];
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
}

export interface OcrPageOptions {
  /** Cap generation (benchmark passes use small values for determinism). */
  maxNewTokens?: number;
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
  /** F11 — ModelRegistry cache checks, worker-side only. */
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
  readonly stats: EngineStats = { modelId: 'mock', device: 'mock', busy: false, loadedAt: null };
  private downloadAbort = false;

  async load(onProgress: ComlinkCallback<DownloadProgress>): Promise<LoadResult> {
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
      return { loadMs: Date.now() - t0, device: 'mock' };
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

class OwnedCacheAdapter {
  constructor(private store: Cache) {}
  match = (key: string) => this.store.match(key);
  put = (key: string, res: Response) => this.store.put(key, res);
  delete = (key: string) => this.store.delete(key);
}

export class GpuLostError extends Error {
  constructor(cause: unknown) {
    super('WebGPU device was lost during inference.', { cause });
    this.name = 'GpuLostError';
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

export class RealEngine implements EngineLike {
  stats: EngineStats = { modelId: null, device: 'webgpu', busy: false, loadedAt: null };
  private spec: AiModelSpec = getModelSpec(AI_MODEL_ID);
  private T: Transformers | null = null;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private processor: any = null;
  private tokenizer: any = null;
  private model: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  private downloadController: AbortController | null = null;

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
    if (this.model) return { loadMs: 0, device: this.stats.device };
    if (opts?.device) this.stats.device = opts.device;
    this.stats.busy = true;
    const t0 = Date.now();
    try {
      onProgress({ phase: 'downloading', percent: null });
      const T = await this.importTransformers();
      this.T = T;
      const o = pipelineOptions(this.spec.id);
      const loadOpts = {
        revision: o.revision,
        dtype: { ...o.dtype },
        device: this.stats.device as 'webgpu' | 'wasm',
        use_external_data_format: o.use_external_data_format,
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
      onProgress({ phase: 'done', percent: 100 });
      return { loadMs: Date.now() - t0, device: this.stats.device };
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
      const longEdge = Math.max(rawImage.width, rawImage.height);
      if (longEdge > MAX_LONG_EDGE) {
        const scale = MAX_LONG_EDGE / longEdge;
        rawImage = await rawImage.resize(Math.round(rawImage.width * scale), Math.round(rawImage.height * scale));
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
      const decoded = this.tokenizer.batch_decode(out, { skip_special_tokens: true })[0] ?? '';
      const inLen = inputs.input_ids.dims ? inputs.input_ids.dims.at(-1) : inputs.input_ids.length;
      const outLen = out.dims ? out.dims.at(-1) : out.length;
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
    this.stats.busy = false;
    try {
      await this.model?.dispose?.();
    } catch {
      /* dispose on a dead session is best-effort */
    }
    this.model = null;
    this.processor = null;
    this.tokenizer = null;
    this.stats.modelId = null;
    this.stats.loadedAt = null;
  }

  /** Registry helpers through the SHARED pipelineOptions tuple (F15). */
  private registryOptions(): Record<string, unknown> {
    const o = pipelineOptions(this.spec.id);
    return {
      revision: o.revision,
      dtype: { ...o.dtype },
      device: this.stats.device,
      use_external_data_format: o.use_external_data_format,
    };
  }

  async downloadInfo(): Promise<DownloadInfo> {
    const T = this.T ?? (await this.importTransformers());
    const opts = this.registryOptions();
    const files = await T.ModelRegistry.get_pipeline_files(this.spec.task, this.spec.repo, opts);
    const store = await caches.open(AI_CACHE_STORE);
    let filesCached = 0;
    for (const f of files) {
      if (await store.match(hfFileUrl(this.spec, String(f)))) filesCached += 1;
    }
    return {
      // isCacheUsable: complete AND marker-verified — a full-but-unverified
      // set (interrupted verify) flows into ensureModelDownloaded, which
      // re-hashes with zero network instead of being loaded unverified.
      cached: await isCacheUsable(
        this.spec,
        store as unknown as CacheLike,
        filesCached,
        files.length,
      ),
      filesCached,
      filesTotal: files.length,
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
