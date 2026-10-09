// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiWorkerClient,
  EngineBusyError,
  GpuLostError,
  type AiClientOptions,
} from '../src/lib/ai-worker-client';
import { RealEngine, AdapterUnavailableError, longEdgeScale } from '../src/workers/ai-ocr.worker';
import { getGpuFallback, resetGpuFallbackStore } from '../src/lib/gpu-fallback-store';
import { beginJob, endJob } from '../src/lib/jobs';
import type { AiOcrApi, EngineStats, LoadResult } from '../src/workers/ai-ocr.worker';

/*
 * Phase 2 units (plan 261009-0836): the dGPU→iGPU→CPU fallback chain,
 * message-based classification (comlink crosses message-only), the
 * precedence state machine, applyGpuChoice gating on the JOB REGISTRY
 * (red-team H5), the one-shot measure override (H6), the gpuHopCount cap
 * WITHOUT the guarded()-reset loophole (H4), and the RealEngine device
 * injection shapes (DI'd gpu).
 */

interface FakeWorker {
  url: string;
  onerror: ((e: Event) => void) | null;
  onmessageerror: (() => void) | null;
  terminate: ReturnType<typeof vi.fn>;
}

function fakeWorkerFactory() {
  const workers: FakeWorker[] = [];
  const spawnWorker = () => {
    const w: FakeWorker = {
      url: 'fake://worker',
      onerror: null,
      onmessageerror: null,
      terminate: vi.fn(),
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
      adapterFingerprint: (opts?.device ?? 'webgpu') === 'wasm' ? null : 'intel|gen-12lp|iris-xe',
    })),
    downloadModel: vi.fn(async () => ({ bytes: 10, downloaded: 10 })),
    cancelDownload: vi.fn(async () => undefined),
    ocrPage: vi.fn(async () => ({ text: 'x', ms: 1, genTokens: 1, tokPerSec: 1, firstTokenMs: 1 })),
    getStats: vi.fn(async () => ({
      modelId: null,
      device: 'webgpu' as const,
      busy: false,
      loadedAt: null,
      adapterFingerprint: null,
    })),
    dispose: vi.fn(async () => undefined),
    getDownloadInfo: vi.fn(async () => ({ cached: false, filesCached: 0, filesTotal: 0, totalBytes: 10 })),
    isCached: vi.fn(async () => false),
    clearCache: vi.fn(async () => 0),
    ...overrides,
  };
}

function makeClient(
  api: AiOcrApi,
  extra: Partial<AiClientOptions> = {},
): { client: AiWorkerClient; workers: FakeWorker[] } {
  const { workers, spawnWorker } = fakeWorkerFactory();
  const client = new AiWorkerClient({
    spawnWorker: spawnWorker as AiClientOptions['spawnWorker'],
    createApi: () => api as never,
    ...extra,
  });
  return { client, workers };
}

/** Stub the GPU request/discovery seams (no navigator.gpu in node). */
function stubGpuSeams(
  client: AiWorkerClient,
  resolved: () => Promise<import('../src/lib/gpu-choice').ResolvedGpuChoice | null>,
  discovery: import('../src/lib/gpu-choice').AdapterDiscovery = {
    adapters: [
      { probe: 'high-performance', info: {}, fingerprint: 'nvidia|ada|0', isFallbackAdapter: false, maxBufferSize: null },
      { probe: 'low-power', info: {}, fingerprint: 'intel|gen-12lp|iris-xe', isFallbackAdapter: false, maxBufferSize: null },
    ],
    probes: {
      hp: { probe: 'high-performance', info: {}, fingerprint: 'nvidia|ada|0', isFallbackAdapter: false, maxBufferSize: null },
      lp: { probe: 'low-power', info: {}, fingerprint: 'intel|gen-12lp|iris-xe', isFallbackAdapter: false, maxBufferSize: null },
    },
  },
): void {
  (client as unknown as { options: AiClientOptions }).options.resolveGpuRequest = resolved;
  (client as unknown as { options: AiClientOptions }).options.probeAdapters = async () => discovery;
}

const loadOptsOf = (api: AiOcrApi): { device?: string; powerPreference?: string } | undefined => {
  const mock = api.loadEngine as ReturnType<typeof vi.fn>;
  const call = mock.mock.calls.at(-1);
  return call?.[2];
};

beforeEach(() => {
  resetGpuFallbackStore();
  endJob('ai-ocr');
  endJob('ai-bench');
});

describe('GPU failure classification (message-based — C1)', () => {
  it('ensureLoaded routes init-failure messages through the chain (was: raw reject)', async () => {
    const api = fakeApi({
      loadEngine: vi.fn(async () => {
        throw new Error('Failed to get a WebGPU adapter (high-performance): requestAdapter returned null');
      }),
    });
    // Dual distinct probes available: the hp request hops to the lp slot.
    const { client, workers } = makeClient(api);
    stubGpuSeams(client, async () => ({ kind: 'gpu', powerPreference: 'high-performance', fingerprint: 'nvidia|ada|0' }));
    await expect(client.ensureLoaded('glm-ocr', () => undefined)).rejects.toThrow(GpuLostError);
    expect(workers[0].terminate).toHaveBeenCalled(); // deliberate respawn
    expect(workers.length).toBeGreaterThanOrEqual(2); // respawned
    const info = getGpuFallback();
    expect(info?.to).toBe('intel|gen-12lp|iris-xe');
    expect(info?.from).toBe('nvidia|ada|0');
  });

  it('ORT device-lost string (not the worker class) still classifies — message only', async () => {
    const api = fakeApi({
      loadEngine: vi.fn(async () => {
        // raw ORT shape crossing comlink — no custom classes survive
        throw new Error('WebGPU device lost (unknown): internal');
      }),
    });
    const { client } = makeClient(api);
    stubGpuSeams(client, async () => null, { adapters: [], probes: { hp: null, lp: null } }); // nothing discoverable
    await expect(client.ensureLoaded('glm-ocr', () => undefined)).rejects.toThrow(GpuLostError);
    const info = getGpuFallback();
    expect(info?.to).toBe('cpu');
  });

  it('a probe crash inside the classifier never masks the original GPU failure', async () => {
    const api = fakeApi({
      loadEngine: vi.fn(async () => {
        throw new Error('WebGPU device lost (unknown): internal');
      }),
    });
    const { client } = makeClient(api);
    stubGpuSeams(client, async () => null);
    (client as unknown as { options: AiClientOptions }).options.probeAdapters = async () => {
      throw new Error('probe exploded');
    };
    // The GPU failure (chain + degrade) must survive — not the probe error.
    await expect(client.ensureLoaded('glm-ocr', () => undefined)).rejects.toThrow(GpuLostError);
    expect(getGpuFallback()?.to).toBe('cpu');
  });

  it('init-fail with NO other adapter degrades to wasm in place (no crash-budget touch)', async () => {
    const api = fakeApi({
      loadEngine: vi.fn(async (_id: string, _p: unknown, opts?: { device?: string }) => {
        if (opts?.device !== 'wasm') {
          throw new Error('another WebGPU EP inference session is being created.');
        }
        return { loadMs: 5, device: 'wasm' as const, adapterFingerprint: null };
      }),
    });
    const { client, workers } = makeClient(api);
    stubGpuSeams(client, async () => null, { adapters: [], probes: { hp: null, lp: null } }); // nothing discoverable
    await expect(client.ensureLoaded('glm-ocr', () => undefined)).rejects.toThrow(
      /another WebGPU EP inference session/,
    );
    expect(workers).toHaveLength(1); // NO respawn — poisoned webgpu, wasm still works
    // the very next load pins wasm
    await client.ensureLoaded('glm-ocr', () => undefined);
    expect(loadOptsOf(api)).toMatchObject({ device: 'wasm' });
  });

  it('hop cap: after one hop a second init-failure degrades — no infinite spawn (H4)', async () => {
    let calls = 0;
    const api = fakeApi({
      loadEngine: vi.fn(async () => {
        calls += 1;
        throw new Error('Failed to get a WebGPU device: boom');
      }),
    });
    const { client, workers } = makeClient(api);
    stubGpuSeams(client, async () => ({ kind: 'gpu', powerPreference: 'high-performance', fingerprint: 'nvidia|ada|0' }));
    await expect(client.ensureLoaded('glm-ocr', () => undefined)).rejects.toThrow(GpuLostError); // hop 1
    await expect(client.ensureLoaded('glm-ocr', () => undefined)).rejects.toThrow(); // no hop 2 → degrade
    expect(calls).toBe(2);
    expect(workers).toHaveLength(2); // exactly ONE deliberate respawn
    await expect(client.ensureLoaded('glm-ocr', () => undefined)).rejects.toThrow();
    expect(loadOptsOf(api)).toMatchObject({ device: 'wasm' });
  });
});

describe('precedence state machine (H3/H2)', () => {
  it('applyGpuChoice clears degrade + pin; the user choice is used on the next load', async () => {
    const api = fakeApi();
    const { client } = makeClient(api);
    // force the degrade state as a device-loss would
    (client as unknown as { degradeToWasm: boolean }).degradeToWasm = true;
    (client as unknown as { pinPowerPreference: string | undefined }).pinPowerPreference = 'low-power';
    stubGpuSeams(client, async () => ({ kind: 'gpu', powerPreference: 'high-performance', fingerprint: 'nvidia|ada|0' }));
    await client.applyGpuChoice();
    await client.ensureLoaded('glm-ocr', () => undefined);
    expect(loadOptsOf(api)).toMatchObject({ powerPreference: 'high-performance' });
    expect(loadOptsOf(api)).not.toHaveProperty('device');
  });

  it('a recovery pin survives until the first successful load, then clears itself', async () => {
    const api = fakeApi();
    const { client } = makeClient(api);
    (client as unknown as { pinPowerPreference: string | undefined }).pinPowerPreference = 'low-power';
    stubGpuSeams(client, async () => ({ kind: 'gpu', powerPreference: 'high-performance', fingerprint: 'nvidia|ada|0' }));
    await client.ensureLoaded('glm-ocr', () => undefined);
    expect(loadOptsOf(api)).toMatchObject({ powerPreference: 'low-power' }); // pin outranks choice mid-recovery
    await client.ensureLoaded('glm-ocr', () => undefined);
    expect(loadOptsOf(api)).toMatchObject({ powerPreference: 'high-performance' }); // cleared after success
  });

  it('degrade outranks an active recovery pin (poisoned webgpu must not re-load GPU)', async () => {
    const api = fakeApi();
    const { client } = makeClient(api);
    (client as unknown as { degradeToWasm: boolean }).degradeToWasm = true;
    (client as unknown as { pinPowerPreference: string | undefined }).pinPowerPreference = 'low-power';
    stubGpuSeams(client, async () => ({ kind: 'gpu', powerPreference: 'high-performance', fingerprint: 'nvidia|ada|0' }));
    await client.ensureLoaded('glm-ocr', () => undefined);
    expect(loadOptsOf(api)).toMatchObject({ device: 'wasm' });
    expect(loadOptsOf(api)).not.toHaveProperty('powerPreference');
  });

  it('Windows collapse (crbug 369219127): both probes the SAME card → no hop, straight to wasm', async () => {
    const api = fakeApi({
      loadEngine: vi.fn(async (_id: string, _p: unknown, opts?: { device?: string }) => {
        if (opts?.device !== 'wasm') {
          throw new Error('Failed to get a WebGPU adapter (high-performance): requestAdapter returned null');
        }
        return { loadMs: 5, device: 'wasm' as const, adapterFingerprint: null };
      }),
    });
    // hp and lp resolve to the SAME adapter (the collapsed single-card
    // machine): hopping to lp would be cosmetic — the candidate skip branch.
    const card = { probe: 'high-performance' as const, info: {}, fingerprint: 'nvidia|ada|4050', isFallbackAdapter: false, maxBufferSize: null };
    const discovery = {
      adapters: [card],
      probes: { hp: card, lp: { ...card, probe: 'low-power' as const } },
    };
    const { client, workers } = makeClient(api);
    stubGpuSeams(client, async () => ({ kind: 'gpu', powerPreference: 'high-performance', fingerprint: 'nvidia|ada|4050' }), discovery);
    await expect(client.ensureLoaded('glm-ocr', () => undefined)).rejects.toThrow(/requestAdapter returned null/);
    expect(workers).toHaveLength(1); // NO respawn — the only candidate IS the used card
    expect(getGpuFallback()?.to).toBe('cpu'); // degraded, not cosmetic-hopped
    await client.ensureLoaded('glm-ocr', () => undefined);
    expect(loadOptsOf(api)).toMatchObject({ device: 'wasm' });
  });

  it('an explicit CPU choice pins device wasm (user outranks everything but recovery)', async () => {
    const api = fakeApi();
    const { client } = makeClient(api);
    stubGpuSeams(client, async () => ({ kind: 'cpu' }));
    await client.ensureLoaded('glm-ocr', () => undefined);
    expect(loadOptsOf(api)).toMatchObject({ device: 'wasm' });
  });
});

describe('applyGpuChoice gating (H5 — job registry, not isBusy)', () => {
  it('an active MAIN-SIDE job blocks apply even though the worker reports idle', async () => {
    const api = fakeApi(); // isBusy → false — the isBusy() gate would MISS this
    const { client } = makeClient(api);
    beginJob('ai-ocr');
    try {
      await expect(client.applyGpuChoice()).rejects.toThrow(EngineBusyError);
      expect(api.dispose).not.toHaveBeenCalled();
    } finally {
      endJob('ai-ocr');
    }
  });

  it('idle → dispose (context re-arm), choice applies without a respawn', async () => {
    const api = fakeApi();
    const { client, workers } = makeClient(api);
    stubGpuSeams(client, async () => ({ kind: 'cpu' }));
    await client.ensureLoaded('glm-ocr', () => undefined);
    await client.applyGpuChoice();
    expect(api.dispose).toHaveBeenCalled();
    expect(workers).toHaveLength(1); // no worker respawn — dispose re-arms (R1 Q5)
  });

  it('worker-side busy still blocks apply (belt and braces behind the registry)', async () => {
    let busy = false;
    const api = fakeApi({ isBusy: vi.fn(async () => busy) });
    const { client } = makeClient(api);
    stubGpuSeams(client, async () => ({ kind: 'cpu' }));
    await client.ensureLoaded('glm-ocr', () => undefined); // worker spawned
    busy = true;
    await expect(client.applyGpuChoice()).rejects.toThrow(EngineBusyError);
    expect(api.dispose).not.toHaveBeenCalled();
  });
});

describe('one-shot measure override (H6)', () => {
  it('ensureLoaded(override) uses the override and never touches the persisted choice', async () => {
    const api = fakeApi();
    const { client } = makeClient(api);
    stubGpuSeams(client, async () => ({ kind: 'gpu', powerPreference: 'low-power', fingerprint: 'intel|gen-12lp|iris-xe' }));
    await client.applyGpuChoice({ kind: 'gpu', powerPreference: 'high-performance', fingerprint: 'nvidia|ada|0' });
    await client.ensureLoaded('glm-ocr', () => undefined);
    expect(loadOptsOf(api)).toMatchObject({ powerPreference: 'high-performance' });
    // consumed: the next load is back on the persisted choice
    await client.ensureLoaded('glm-ocr', () => undefined);
    expect(loadOptsOf(api)).toMatchObject({ powerPreference: 'low-power' });
  });

  it('effectiveRequest reports the honest current request', async () => {
    const api = fakeApi();
    const { client } = makeClient(api);
    stubGpuSeams(client, async () => ({ kind: 'gpu', powerPreference: 'low-power', fingerprint: 'intel|gen-12lp|iris-xe' }));
    expect(await client.effectiveRequest()).toMatchObject({ device: 'webgpu', powerPreference: 'low-power' });
    (client as unknown as { degradeToWasm: boolean }).degradeToWasm = true;
    expect(await client.effectiveRequest()).toMatchObject({ device: 'wasm', degraded: true });
  });
});

/* ------------------------- RealEngine injection (DI) ---------------------- */

function fakeGpuAdapter(opts: { vendor?: string; architecture?: string; null?: boolean; throw?: boolean } = {}) {
  const device: { destroyed: boolean; destroy(): void } = {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  const adapter = {
    features: new Set(['shader-f16']),
    limits: { maxBufferSize: 4 * 1024 ** 3 },
    info: { vendor: opts.vendor ?? 'nvidia', architecture: opts.architecture ?? 'ada', device: '4050', description: '' },
    requestDevice: vi.fn(async () => device),
  };
  return {
    adapter,
    device,
    gpu: {
      requestAdapter: vi.fn(async (o?: { powerPreference?: string }) => {
        if (opts.throw) throw new Error('probe exploded');
        if (opts.null) return null;
        void o;
        return adapter;
      }),
    } as unknown as Navigator['gpu'],
  };
}


describe('RealEngine device injection (R1 mechanism)', () => {
  it('webgpu load requests the adapter, injects the device, records the fingerprint', async () => {
    const { gpu, adapter, device } = fakeGpuAdapter();
    const engine = new RealEngine(gpu);
    // Patch the transformers import + the three from_pretrained calls.
    const captured: Array<Record<string, unknown>> = [];
    const T = {
      env: { allowLocalModels: false, useBrowserCache: false, useCustomCache: true, customCache: null, backends: { onnx: { wasm: null } } },
      AutoProcessor: { from_pretrained: vi.fn(async () => ({ dispose: async () => undefined })) },
      AutoTokenizer: { from_pretrained: vi.fn(async () => ({ dispose: async () => undefined })) },
      AutoModelForImageTextToText: {
        from_pretrained: vi.fn(async (_repo: string, opts: Record<string, unknown>) => {
          captured.push(opts);
          return { dispose: async () => undefined };
        }),
      },
    };
    (engine as unknown as { importTransformers: () => Promise<unknown> }).importTransformers = async () => T;
    const result = await engine.load(() => undefined, { powerPreference: 'high-performance' });
    expect(gpu.requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
    expect(adapter.requestDevice).toHaveBeenCalledWith({ requiredFeatures: ['shader-f16'] });
    expect(result.device).toBe('webgpu');
    expect(result.adapterFingerprint).toBe('nvidia|ada|4050');
    expect(engine.stats.adapterFingerprint).toBe('nvidia|ada|4050');
    const sessionOptions = captured[0]?.session_options as { executionProviders: Array<{ name: string; device: unknown }> };
    expect(sessionOptions.executionProviders[0].name).toBe('webgpu');
    expect(sessionOptions.executionProviders[0].device).toBe(device);
  });

  it('adapter null → AdapterUnavailableError with a classifier-shaped message', async () => {
    const { gpu } = fakeGpuAdapter({ null: true });
    const engine = new RealEngine(gpu);
    const T = {
      env: { allowLocalModels: false, useBrowserCache: false, useCustomCache: true, customCache: null, backends: { onnx: { wasm: null } } },
      AutoProcessor: { from_pretrained: vi.fn(async () => ({})) },
      AutoTokenizer: { from_pretrained: vi.fn(async () => ({})) },
      AutoModelForImageTextToText: { from_pretrained: vi.fn(async () => ({})) },
    };
    (engine as unknown as { importTransformers: () => Promise<unknown> }).importTransformers = async () => T;
    const err = await engine.load(() => undefined, { powerPreference: 'low-power' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterUnavailableError);
    expect((err as Error).message).toContain('Failed to get a WebGPU adapter');
    expect((err as Error).message).toContain('low-power');
  });

  it('wasm load skips the adapter probe entirely', async () => {
    const { gpu } = fakeGpuAdapter();
    const engine = new RealEngine(gpu);
    const T = {
      env: { allowLocalModels: false, useBrowserCache: false, useCustomCache: true, customCache: null, backends: { onnx: { wasm: null } } },
      AutoProcessor: { from_pretrained: vi.fn(async () => ({})) },
      AutoTokenizer: { from_pretrained: vi.fn(async () => ({})) },
      AutoModelForImageTextToText: { from_pretrained: vi.fn(async () => ({})) },
    };
    (engine as unknown as { importTransformers: () => Promise<unknown> }).importTransformers = async () => T;
    const result: LoadResult = await engine.load(() => undefined, { device: 'wasm' });
    expect(gpu.requestAdapter).not.toHaveBeenCalled();
    expect(result.device).toBe('wasm');
    expect(result.adapterFingerprint).toBeNull();
  });

  it('dispose releases ALL THREE sessions + the owned device (R1 Q5 re-arm)', async () => {
    const { gpu, device } = fakeGpuAdapter();
    const engine = new RealEngine(gpu);
    const disposes = { processor: vi.fn(), tokenizer: vi.fn(), model: vi.fn() };
    const T = {
      env: { allowLocalModels: false, useBrowserCache: false, useCustomCache: true, customCache: null, backends: { onnx: { wasm: null } } },
      AutoProcessor: { from_pretrained: vi.fn(async () => ({ dispose: disposes.processor })) },
      AutoTokenizer: { from_pretrained: vi.fn(async () => ({ dispose: disposes.tokenizer })) },
      AutoModelForImageTextToText: { from_pretrained: vi.fn(async () => ({ dispose: disposes.model })) },
    };
    (engine as unknown as { importTransformers: () => Promise<unknown> }).importTransformers = async () => T;
    await engine.load(() => undefined, {});
    await engine.dispose();
    expect(disposes.model).toHaveBeenCalled();
    expect(disposes.processor).toHaveBeenCalled();
    expect(disposes.tokenizer).toHaveBeenCalled();
    expect(device.destroyed).toBe(true);
    expect(engine.stats.adapterFingerprint).toBeNull();
    expect(engine.stats.loadedAt).toBeNull();
  });

  it('review P1: device choice is LOAD-SCOPED — wasm → dispose → GPU load probes again', async () => {
    const { gpu, adapter } = fakeGpuAdapter();
    const engine = new RealEngine(gpu);
    const T = {
      env: { allowLocalModels: false, useBrowserCache: false, useCustomCache: true, customCache: null, backends: { onnx: { wasm: null } } },
      AutoProcessor: { from_pretrained: vi.fn(async () => ({})) },
      AutoTokenizer: { from_pretrained: vi.fn(async () => ({})) },
      AutoModelForImageTextToText: { from_pretrained: vi.fn(async () => ({})) },
    };
    (engine as unknown as { importTransformers: () => Promise<unknown> }).importTransformers = async () => T;
    await engine.load(() => undefined, { device: 'wasm' });
    expect(engine.stats.device).toBe('wasm');
    await engine.dispose();
    // The sticky-stats bug: the GPU-pref load carried no device and silently
    // stayed wasm (requestAdapter never called) — apply-without-restart was
    // dead for every wasm→GPU transition.
    const result: LoadResult = await engine.load(() => undefined, { powerPreference: 'high-performance' });
    expect(gpu.requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
    expect(adapter.requestDevice).toHaveBeenCalled();
    expect(result.device).toBe('webgpu');
    expect(engine.stats.device).toBe('webgpu');
  });

  it('review P3: a failed model load releases the injected device (no orphan)', async () => {
    const { gpu, device } = fakeGpuAdapter();
    const engine = new RealEngine(gpu);
    const T = {
      env: { allowLocalModels: false, useBrowserCache: false, useCustomCache: true, customCache: null, backends: { onnx: { wasm: null } } },
      AutoProcessor: { from_pretrained: vi.fn(async () => ({})) },
      AutoTokenizer: { from_pretrained: vi.fn(async () => ({})) },
      AutoModelForImageTextToText: {
        from_pretrained: vi.fn(async () => {
          throw new Error('model boom');
        }),
      },
    };
    (engine as unknown as { importTransformers: () => Promise<unknown> }).importTransformers = async () => T;
    await expect(engine.load(() => undefined, { powerPreference: 'high-performance' })).rejects.toThrow('model boom');
    expect(device.destroyed).toBe(true);
    expect(engine.stats.busy).toBe(false);
  });
});

describe('longEdgeScale (phase 3 worker resize math)', () => {
  it('caps the long edge, preserves aspect, passes through below the cap', () => {
    expect(longEdgeScale(2000, 1000, 1024)).toEqual({ width: 1024, height: 512 });
    expect(longEdgeScale(1000, 2000, 768)).toEqual({ width: 384, height: 768 });
    expect(longEdgeScale(800, 600, 1024)).toBeNull();
  });
});
