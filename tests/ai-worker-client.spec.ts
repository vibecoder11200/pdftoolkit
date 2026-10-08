// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiWorkerClient,
  GpuLostError,
  WorkerCrashError,
  type AiClientOptions,
} from '../src/lib/ai-worker-client';
import type { AiOcrApi, EngineStats } from '../src/workers/ai-ocr.worker';

/*
 * Phase 2b lifecycle units (F6/F8): busy-guarded dispose timers, crash →
 * restart with pending-call rejection, GPU-loss degrade, and the mock URL
 * seam. The comlink Worker seam is injected, so no real worker runs here.
 */

interface FakeWorker {
  url: string;
  onerror: ((e: Event) => void) | null;
  onmessageerror: (() => void) | null;
  terminate: ReturnType<typeof vi.fn>;
  fireError(): void;
}

function fakeWorkerFactory() {
  const workers: FakeWorker[] = [];
  const spawnWorker = () => {
    const w: FakeWorker = {
      url: 'fake://worker',
      onerror: null,
      onmessageerror: null,
      terminate: vi.fn(),
      fireError() {
        w.onerror?.(new Event('error'));
      },
    };
    workers.push(w);
    return w as unknown as Worker;
  };
  return { workers, spawnWorker };
}

function fakeApi(overrides: Partial<AiOcrApi> = {}): AiOcrApi {
  return {
    isBusy: vi.fn(async () => false),
    loadEngine: vi.fn(async (_modelId: string, _onProgress: unknown, opts?: { device?: string }) => ({
      loadMs: 5,
      device: (opts?.device ?? 'webgpu') as EngineStats['device'],
    })),
    downloadModel: vi.fn(async () => ({ bytes: 10, downloaded: 10 })),
    cancelDownload: vi.fn(async () => undefined),
    ocrPage: vi.fn(async () => ({ text: 'x', ms: 1, genTokens: 1, tokPerSec: 1, firstTokenMs: 1 })),
    getStats: vi.fn(async () => ({ modelId: null, device: 'webgpu' as const, busy: false, loadedAt: null })),
    dispose: vi.fn(async () => undefined),
    getDownloadInfo: vi.fn(async () => ({ cached: false, filesCached: 0, filesTotal: 0, totalBytes: 10 })),
    isCached: vi.fn(async () => false),
    clearCache: vi.fn(async () => 0),
    ...overrides,
  };
}

function makeClient(opts: Omit<AiClientOptions, 'spawnWorker' | 'createApi'> & {
  spawnWorker: AiClientOptions['spawnWorker'];
  api: AiOcrApi;
}) {
  const { api, ...rest } = opts;
  const createApis: RemotelessApi[] = [];
  const client = new AiWorkerClient({
    ...rest,
    createApi: () => {
      createApis.push(api);
      return api as never;
    },
  });
  return { client, createApis };
}
type RemotelessApi = AiOcrApi;

const noop = () => undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AiWorkerClient lifecycle (F6)', () => {
  it('idle timer disposes a NON-busy engine after 10 minutes', async () => {
    const { workers, spawnWorker } = fakeWorkerFactory();
    const api = fakeApi();
    const { client } = makeClient({ spawnWorker, api, idleMs: 10 * 60_000, onWorkerCrash: noop });
    await client.ensureLoaded('glm-ocr', noop); // activity arms the idle timer
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    expect(api.dispose).toHaveBeenCalledTimes(1);
  });

  it('busy blocks dispose — the timer re-arms until the job ends (dispose-under-job never happens)', async () => {
    const { spawnWorker } = fakeWorkerFactory();
    let busy = true;
    const api = fakeApi({ isBusy: vi.fn(async () => busy) });
    const { client } = makeClient({ spawnWorker, api, idleMs: 10 * 60_000 });
    await client.ensureLoaded('glm-ocr', noop); // arms the idle timer
    // three consecutive idle ticks while busy — dispose must never run
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(api.dispose).not.toHaveBeenCalled();
    }
    busy = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    expect(api.dispose).toHaveBeenCalledTimes(1);
  });

  it('hidden tab ≥5 min disposes; visible cancels the hidden timer', async () => {
    const { spawnWorker } = fakeWorkerFactory();
    const api = fakeApi();
    const { client } = makeClient({ spawnWorker, api, idleMs: 60 * 60_000, hiddenMs: 5 * 60_000 });
    await client.ensureLoaded('glm-ocr', noop); // arms idle + hooks visibility
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(api.dispose).not.toHaveBeenCalled(); // cancelled at 4min
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(api.dispose).toHaveBeenCalledTimes(1);
  });

  it('worker crash rejects PENDING calls (they never settle otherwise) and respawns', async () => {
    const { workers, spawnWorker } = fakeWorkerFactory();
    let calls = 0;
    const api = fakeApi({
      ocrPage: vi.fn(
        (): Promise<never> =>
          new Promise((_, reject) => {
            calls += 1;
            void reject;
            // never settles — the crash must reject it from outside
          }),
      ),
    });
    const onWorkerCrash = vi.fn();
    const { client } = makeClient({ spawnWorker, api, onWorkerCrash });
    const pagePromise = client.ocrPage({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, noop);
    await Promise.resolve();
    expect(workers).toHaveLength(1);
    workers[0].fireError();
    await expect(pagePromise).rejects.toBeInstanceOf(WorkerCrashError);
    expect(onWorkerCrash).toHaveBeenCalledWith(1);
    expect(workers).toHaveLength(2); // respawned
    // the new worker serves new calls
    await expect(client.isBusy()).resolves.toBe(false);
    expect(calls).toBe(1);
  });

  it('GPU-lost message → onGpuLost + respawn, and the next load pins device wasm (F6 degrade)', async () => {
    const { workers, spawnWorker } = fakeWorkerFactory();
    const api = fakeApi({
      ocrPage: vi.fn(async (): Promise<never> => {
        throw new Error('WebGPU device was lost during inference.');
      }),
    });
    const onGpuLost = vi.fn();
    const { client } = makeClient({ spawnWorker, api, onGpuLost, onWorkerCrash: noop });
    await expect(
      client.ocrPage({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, noop),
    ).rejects.toBeInstanceOf(GpuLostError);
    expect(onGpuLost).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(2);
    await client.ensureLoaded('glm-ocr', noop);
    expect(api.loadEngine).toHaveBeenCalledWith('glm-ocr', expect.anything(), { device: 'wasm' });
  });

  it('mock seam is a client flag (F8) — worker spawns through the same factory', async () => {
    const { workers, spawnWorker } = fakeWorkerFactory();
    const api = fakeApi();
    const client = new AiWorkerClient({ spawnWorker, createApi: () => api as never, mock: true });
    await client.isBusy();
    expect(workers).toHaveLength(1); // same spawn path; the real bundle passes name 'ai-mock'
    client.destroy();
    expect(workers[0].terminate).toHaveBeenCalled();
  });

  it('destroy() terminates the worker (page teardown)', async () => {
    const { workers, spawnWorker } = fakeWorkerFactory();
    const api = fakeApi();
    const client = new AiWorkerClient({ spawnWorker, createApi: () => api as never });
    await client.isBusy();
    client.destroy();
    expect(workers[0].terminate).toHaveBeenCalled();
  });
});
