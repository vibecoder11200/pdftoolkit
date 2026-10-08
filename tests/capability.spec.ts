// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  adapterFingerprint,
  createBenchmarkStore,
  detectHardware,
  isBenchmarkStale,
  resolveTier,
  runBenchmark,
  type BenchmarkExecutor,
  type BenchmarkRecord,
  type HardwareInfo,
} from '../src/lib/capability';
import type { IDBDatabaseLike } from '../src/lib/idb-benchmarks';

/*
 * Phase 3 units (F17/F23): tier ladder over mocked navigator.gpu combos,
 * benchmark persist/read/stale-detect, and the resolution order
 * (fresh benchmark > estimate).
 */

function fakeGpu(adapter: Partial<GPUAdapter> | null) {
  return {
    requestAdapter: async () => adapter,
  } as unknown as Navigator['gpu'];
}

function adapterWith(opts: {
  vendor?: string;
  architecture?: string;
  isFallback?: boolean;
  maxBufferSize?: number;
}): Partial<GPUAdapter> {
  return {
    limits: { maxBufferSize: opts.maxBufferSize ?? 4 * 1024 ** 3 } as GPUSupportedLimits,
    ...(opts.isFallback !== undefined ? { isFallbackAdapter: opts.isFallback } : {}),
    ...(opts.vendor !== undefined || opts.architecture !== undefined
      ? {
          info: {
            vendor: opts.vendor ?? '',
            architecture: opts.architecture ?? '',
            device: '',
            description: '',
          } as GPUAdapterInfo,
        }
      : {}),
  };
}

const HW: Omit<HardwareInfo, 'tier' | 'tierSource'> = {
  webgpu: true,
  adapter: { vendor: 'intel', architecture: 'gen-12lp', device: 'iris-xe' },
  isFallbackAdapter: false,
  deviceMemoryGB: 16,
  maxBufferSize: 4 * 1024 ** 3,
  storage: { usage: 1e9, quota: 1e12 },
};

const hwWith = (over: Partial<HardwareInfo>): HardwareInfo => ({
  ...HW,
  tier: 'gpu-strong',
  tierSource: 'estimate',
  ...over,
});

describe('detectHardware tiers (D4 ladder)', () => {
  it('no navigator.gpu → none', async () => {
    const hw = await detectHardware(undefined, async () => ({}));
    expect(hw.tier).toBe('none');
    expect(hw.webgpu).toBe(false);
  });

  it('requestAdapter null → none (WebGPU present but no adapter)', async () => {
    const hw = await detectHardware(fakeGpu(null), async () => ({}));
    expect(hw.tier).toBe('none');
    expect(hw.webgpu).toBe(true);
  });

  it('fallback (software) adapter → cpu', async () => {
    const hw = await detectHardware(fakeGpu(adapterWith({ isFallback: true, maxBufferSize: 8 * 1024 ** 3 })), async () => ({}));
    expect(hw.tier).toBe('cpu');
  });

  it('old Chrome without adapter.info (F23) still tiers by limits', async () => {
    const adapter = { limits: { maxBufferSize: 2 * 1024 ** 3 } } as Partial<GPUAdapter>;
    const hw = await detectHardware(fakeGpu(adapter), async () => ({}));
    expect(hw.tier).toBe('gpu-strong'); // 2GiB buffer + no RAM hint (null)
    expect(hw.adapter).toEqual({});
  });

  it('deviceMemory < 4GB caps to cpu even with a big buffer (RAM peak gate)', async () => {
    const saved = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 2 });
    try {
      const hw = await detectHardware(fakeGpu(adapterWith({ maxBufferSize: 4 * 1024 ** 3 })), async () => ({}));
      expect(hw.tier).toBe('cpu');
    } finally {
      if (saved === undefined) Reflect.deleteProperty(navigator, 'deviceMemory');
      else Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: saved });
    }
  });

  it('strong buffer + ≥8GB → gpu-strong; small buffer → gpu-weak', async () => {
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
    try {
      const strong = await detectHardware(fakeGpu(adapterWith({ maxBufferSize: 2 * 1024 ** 3, vendor: 'nvidia' })), async () => ({}));
      expect(strong.tier).toBe('gpu-strong');
      const weak = await detectHardware(fakeGpu(adapterWith({ maxBufferSize: 1 * 1024 ** 3, vendor: 'nvidia' })), async () => ({}));
      expect(weak.tier).toBe('gpu-weak');
    } finally {
      Reflect.deleteProperty(navigator, 'deviceMemory');
    }
  });
});

/* ------------------------------- T5 benchmark ------------------------------ */

function fakeDb() {
  const map = new Map<string, unknown>();
  const conn: IDBDatabaseLike = {
    get: async (k) => map.get(k),
    put: async (v, k) => void map.set(k, v),
    getAllKeys: async () => [...map.keys()],
    close: () => undefined,
  };
  return { map, store: createBenchmarkStore(Promise.resolve(conn)) };
}

function executorWith(genTokens: number, ms: number, firstTokenMs: number | null): BenchmarkExecutor {
  let calls = 0;
  return {
    generate: async () => {
      calls += 1;
      return { genTokens: calls === 1 ? 16 : genTokens, ms: calls === 1 ? 10 : ms, firstTokenMs: calls === 1 ? 9000 : firstTokenMs };
    },
  };
}

describe('T5 benchmark (F17 protocol + persistence)', () => {
  it('warmup discarded, measured pass persisted with fingerprint + tok/s', async () => {
    const { store } = fakeDb();
    const rec = await runBenchmark(
      'glm-ocr',
      'webgpu',
      'intel|gen-12lp|iris-xe',
      executorWith(640, 10_000, 8_500),
      store,
    );
    expect(rec.tokPerSecWarm).toBe(64);
    expect(rec.adapterFingerprint).toBe('intel|gen-12lp|iris-xe');
    const all = await store.loadAll();
    expect(all['glm-ocr']).toEqual(rec);
  });

  it('stale detection: fingerprint mismatch marks stale, does not resolve measured', () => {
    const rec: BenchmarkRecord = {
      modelId: 'glm-ocr',
      tokPerSecWarm: 64,
      firstTokenColdMs: 8500,
      condition: 'webgpu',
      measuredAt: Date.now(),
      adapterFingerprint: 'intel|gen-12lp|iris-xe',
    };
    expect(isBenchmarkStale(rec, 'intel|gen-12lp|iris-xe')).toBe(false);
    expect(isBenchmarkStale(rec, 'nvidia|ada|4060')).toBe(true);
    const hw = hwWith({ adapter: { vendor: 'nvidia', architecture: 'ada', device: '4060' } });
    const res = resolveTier(hw, rec);
    expect(res.source).toBe('estimate'); // stale → falls back to estimate
    expect(res.stale).toBe(true);
  });

  it('resolution order: fresh measured beats estimate, both directions', () => {
    const strongRec: BenchmarkRecord = {
      modelId: 'glm-ocr',
      tokPerSecWarm: 80,
      firstTokenColdMs: 900,
      condition: 'webgpu',
      measuredAt: Date.now(),
      adapterFingerprint: adapterFingerprint(HW.adapter),
    };
    const weakHw = hwWith({ maxBufferSize: 1 * 1024 ** 3, tier: 'gpu-weak' });
    expect(resolveTier(weakHw, strongRec)).toMatchObject({ source: 'measured', tier: 'gpu-strong' });

    const slowRec: BenchmarkRecord = { ...strongRec, tokPerSecWarm: 16 };
    const strongHw = hwWith({});
    expect(resolveTier(strongHw, slowRec)).toMatchObject({ source: 'measured', tier: 'gpu-weak' });

    expect(resolveTier(hwWith({}), undefined)).toMatchObject({ source: 'estimate', stale: false });
  });
});
