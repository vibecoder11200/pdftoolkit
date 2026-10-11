import { isTauri } from './platform';
import type { DownloadProgress } from './ai-models';
import type { AiRunClient } from './ai-run';
import type { OcrPageOptions } from '../workers/ai-ocr.worker';
import type { RasterImageData } from '../workers/pdf.worker';
import {
  NativeEngineError,
  toNativeEngineError,
} from './native-errors';
import type {
  NativeCommandErrorShape,
  NativeDownloadFrame,
  NativeDownloadKind,
  NativeOcrPageResult,
  NativeStatus,
  NativeTokenFrame,
} from './native-types';

/*
 * `AiRunClient` over the Rust sidecar commands (v0.6.0 phase 4, R4.3).
 * Structural twin of AiWorkerClient: `runAiPages` runs untouched — download
 * → load → page loop with resume all come free through the seam. The
 * webview NEVER fetches the sidecar; every method goes through invoke, and
 * `@tauri-apps/api/core` is only ever reached via dynamic import
 * (desktop-gpu-force pattern) so the web bundle keeps this chunk out
 * entirely.
 *
 * ONE client for the whole app (`sharedNativeClient`, review F1): the OCR
 * tool AND the phase 5 Settings card drive this single instance — one
 * in-flight slot, one download stream, one state machine. Rust owns the
 * idle timer (10 min, re-armed only by OCR traffic and explicit
 * start/stop); this client holds NO idle logic (R4.6).
 */

/** Local extended raster type — review F4's ONE dataUrl mechanism: the
 *  ocr-tool render closure attaches a canvas-native PNG dataUrl ONLY when
 *  the engine is native; `runAiPages` and `pdf.worker.ts` types stay
 *  untouched (no OcrPageOptions variant exists). */
export type NativeRasterImageData = RasterImageData & { dataUrl?: string };

/** The benchmark honesty marker (review F2): a NON-NULL constant — `null`
 *  would fall through to the WebGPU fingerprint key in runAiPages and
 *  overwrite web records of the same machine. */
export const NATIVE_ADAPTER_FINGERPRINT = 'native';

type TauriCore = typeof import('@tauri-apps/api/core');

async function core(): Promise<TauriCore> {
  return await import('@tauri-apps/api/core');
}

/** Status read (R4.6: NON-activity — never re-arms the Rust idle timer). */
export async function getNativeStatus(): Promise<NativeStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await core();
    return await invoke<NativeStatus>('native_engine_status');
  } catch {
    return null;
  }
}

export class AiNativeClient implements AiRunClient {
  /** Cumulative token count of the current run. The web onToken fires PER
   *  TOKEN; native frames batch ~40ms of tokens (review F4), so consumers
   *  read the count from here instead of counting callbacks. Monotonic
   *  across pages of a run; reset only by a fresh page load of the app. */
  tokenCount = 0;

  private ensureDesktop(): void {
    if (!isTauri()) {
      throw new NativeEngineError('The native OCR engine is desktop-only.');
    }
  }

  async ensureLoaded(
    _modelId: string,
    _onProgress: (p: DownloadProgress) => void,
    _loadOpts?: { override?: unknown },
  ): Promise<{
    loadMs: number;
    device: 'native';
    adapterFingerprint: string;
    backend?: 'vulkan' | 'cuda' | 'metal' | 'cpu';
  }> {
    this.ensureDesktop();
    const { invoke } = await core();
    const t0 = performance.now();
    const status = await invoke<NativeStatus>('native_engine_start').catch((e: unknown) => {
      throw toNativeEngineError(e);
    });
    if (status.phase !== 'ready') {
      throw new NativeEngineError(`Engine is ${status.phase}, not ready.`);
    }
    return {
      loadMs: Math.round(performance.now() - t0),
      device: 'native',
      adapterFingerprint: NATIVE_ADAPTER_FINGERPRINT,
      // 'unknown' (no engagement lines parsed) records NO backend rather
      // than a false one (review F14).
      backend:
        status.backend && status.backend !== 'unknown' ? status.backend : undefined,
    };
  }

  /** First-use flow (contract acceptance 2): engine first if absent, then
   *  model. A second concurrent call attaches to the same single-flight
   *  Rust download (review F9). */
  async downloadModel(
    _modelId: string,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<{ bytes: number; downloaded: number }> {
    this.ensureDesktop();
    const { invoke } = await core();
    const status = await invoke<NativeStatus>('native_engine_status').catch(
      (e: unknown) => {
        throw toNativeEngineError(e);
      },
    );
    let downloaded = 0;
    let total = 0;
    if (!status.enginePresent) {
      const r = await this.downloadKind('engine', onProgress);
      downloaded += r.downloaded;
      total += r.total;
    }
    if (!status.modelPresent) {
      const r = await this.downloadKind('model', onProgress);
      downloaded += r.downloaded;
      total += r.total;
    }
    return { bytes: total, downloaded };
  }

  private downloadKind(
    kind: NativeDownloadKind,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<{ downloaded: number; total: number }> {
    this.ensureDesktop();
    return core().then(({ invoke, Channel }) => {
      return new Promise<{ downloaded: number; total: number }>((resolve, reject) => {
        const ch = new Channel<NativeDownloadFrame>();
        ch.onmessage = (f) => {
          onProgress({
            phase: 'downloading',
            loaded: f.loaded,
            total: f.total,
            percent: f.percent,
          });
        };
        invoke<number>('native_engine_download', { kind, onProgress: ch }).then(
          (bytes) => resolve({ downloaded: bytes, total: bytes }),
          (e: unknown) => reject(toNativeEngineError(e)),
        );
      });
    });
  }

  /** Cancels the in-flight downloads (never a running engine — the Rust
   *  'engine'-kind stop only fires when the engine is NOT downloading). */
  async cancelDownload(): Promise<void> {
    this.ensureDesktop();
    const { invoke } = await core();
    await invoke('native_cancel', { kind: 'model' }).catch(() => {});
    await invoke('native_cancel', { kind: 'engine' }).catch(() => {});
  }

  async isCached(_modelId: string): Promise<boolean> {
    this.ensureDesktop();
    const status = await getNativeStatus();
    if (!status) throw new NativeEngineError('native engine status unavailable');
    return status.enginePresent && status.modelPresent;
  }

  async getDownloadInfo(_modelId: string): Promise<{
    cached: boolean;
    filesCached: number;
    filesTotal: number;
    totalBytes: number;
  }> {
    this.ensureDesktop();
    const status = await getNativeStatus();
    if (!status) throw new NativeEngineError('native engine status unavailable');
    const engineReady = status.enginePresent ? 1 : 0;
    const modelReady = status.modelPresent ? 1 : 0;
    return {
      cached: engineReady + modelReady === 2,
      filesCached: engineReady + modelReady,
      filesTotal: 2,
      totalBytes: status.sizes.engine + status.sizes.model,
    };
  }

  /** Stops the engine (never deletes a running engine's files), then frees
   *  both installs. Returns bytes freed. */
  async clearCache(_modelId: string): Promise<number> {
    this.ensureDesktop();
    const { invoke } = await core();
    await invoke('native_cancel', { kind: 'engine' }).catch(() => {});
    const model = await invoke<number>('native_engine_delete', { kind: 'model' }).catch(
      (e: unknown) => {
        throw toNativeEngineError(e);
      },
    );
    const engine = await invoke<number>('native_engine_delete', { kind: 'engine' }).catch(
      (e: unknown) => {
        throw toNativeEngineError(e);
      },
    );
    return model + engine;
  }

  async ocrPage(
    image: RasterImageData,
    onToken: (chunk: string) => void,
    opts?: OcrPageOptions,
  ): Promise<{
    text: string;
    ms: number;
    genTokens: number;
    tokPerSec: number;
    firstTokenMs: number | null;
  }> {
    this.ensureDesktop();
    const raster = image as NativeRasterImageData;
    if (!raster.dataUrl) {
      throw new NativeEngineError('native engine page render missing its dataUrl');
    }
    const { invoke, Channel } = await core();
    const ch = new Channel<NativeTokenFrame>();
    ch.onmessage = (f) => {
      this.tokenCount += f.tokenDelta;
      if (f.delta) onToken(f.delta);
    };
    const r = await invoke<NativeOcrPageResult>(
      'native_ocr_page',
      {
        args: { imageDataUrl: raster.dataUrl, maxTokens: opts?.maxNewTokens },
        onToken: ch,
      },
    ).catch((e: unknown) => {
      throw toNativeEngineError(e);
    });
    return {
      text: r.text,
      ms: r.ms,
      genTokens: r.genTokens,
      tokPerSec: r.tokPerSec,
      firstTokenMs: r.firstTokenMs,
    };
  }

  /** Classified detail of the LAST engine failure, for the error UI. */
  async lastError(): Promise<NativeCommandErrorShape | null> {
    const status = await getNativeStatus();
    return status?.lastError ?? null;
  }
}

/* Shared client (review F1): one in-flight slot, one download stream, one
 * state machine for the whole app. */
let shared: AiNativeClient | null = null;

export function sharedNativeClient(): AiNativeClient {
  if (!shared) shared = new AiNativeClient();
  return shared;
}
