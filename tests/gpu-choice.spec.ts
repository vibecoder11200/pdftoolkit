// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adapterPowerClass,
  getGpuChoice,
  gpuChoiceLabel,
  probeAdapters,
  resetGpuChoiceStore,
  resolveChoice,
  setGpuChoice,
  subscribeGpuChoice,
  GPU_CHOICE_KEY,
  type AdapterDiscovery,
  type DiscoveredAdapter,
  type GpuChoice,
} from '../src/lib/gpu-choice';
import { readAdapterFallbackFlag, detectHardware } from '../src/lib/capability';

/*
 * Phase 1 units: dual-probe discovery + dedupe + software labeling, the
 * persisted choice store (observable + localStorage), and the resolve matrix.
 * Fakes mirror the real machine's shapes, including F23 (no .info) and the
 * Chrome-140 isFallbackAdapter attribute removal (info field only).
 */

function fakeAdapter(opts: {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  /** info-field flag (Chrome 136+) — current Chrome has NO legacy attribute. */
  infoFallback?: boolean;
  /** legacy attribute (removed in Chrome 140) — old-Chrome shape. */
  legacyFallback?: boolean;
  maxBufferSize?: number;
  /** F23 old Chrome: neither .info nor its accessors exist. */
  noInfo?: boolean;
}): GPUAdapter {
  const info = opts.noInfo
    ? undefined
    : ({
        vendor: opts.vendor ?? '',
        architecture: opts.architecture ?? '',
        device: opts.device ?? '',
        description: opts.description ?? '',
        ...(opts.infoFallback !== undefined ? { isFallbackAdapter: opts.infoFallback } : {}),
      } as GPUAdapterInfo);
  return {
    ...(info ? { info } : {}),
    ...(opts.legacyFallback !== undefined ? { isFallbackAdapter: opts.legacyFallback } : {}),
    limits: { maxBufferSize: opts.maxBufferSize ?? 4 * 1024 ** 3 } as GPUSupportedLimits,
  } as unknown as GPUAdapter;
}

function fakeGpu(map: {
  hp?: GPUAdapter | null;
  lp?: GPUAdapter | null;
  bare?: GPUAdapter | null;
  throwOnHp?: boolean;
  seen?: Array<GPURequestAdapterOptions | undefined>;
}): Navigator['gpu'] {
  return {
    requestAdapter: async (opts?: GPURequestAdapterOptions) => {
      map.seen?.push(opts);
      if (opts?.powerPreference === 'high-performance') {
        if (map.throwOnHp) throw new Error('probe exploded');
        return map.hp ?? null;
      }
      if (opts?.powerPreference === 'low-power') return map.lp ?? null;
      return map.bare ?? null;
    },
  } as unknown as Navigator['gpu'];
}

const DGPU = () =>
  fakeAdapter({ vendor: 'nvidia', architecture: 'ada', device: '4050', infoFallback: false, maxBufferSize: 8 * 1024 ** 3 });
const IGPU = () => fakeAdapter({ vendor: 'intel', architecture: 'gen-12lp', device: 'iris-xe', maxBufferSize: 2 * 1024 ** 3 });

function disc(partial: Partial<DiscoveredAdapter> & { fingerprint: string }): DiscoveredAdapter {
  return { probe: 'high-performance', info: {}, isFallbackAdapter: false, maxBufferSize: null, ...partial };
}

const FP_DGPU = 'nvidia|ada|4050';
const FP_IGPU = 'intel|gen-12lp|iris-xe';
const FP_SWIFT = 'google|swiftshader|?';

const DISCOVERY_DUAL: AdapterDiscovery = {
  adapters: [
    disc({ fingerprint: FP_DGPU, probe: 'high-performance', info: { vendor: 'nvidia', architecture: 'ada', device: '4050' } }),
    disc({ fingerprint: FP_IGPU, probe: 'low-power', info: { vendor: 'intel', architecture: 'gen-12lp', device: 'iris-xe' } }),
  ],
  probes: {
    hp: disc({ fingerprint: FP_DGPU, probe: 'high-performance' }),
    lp: disc({ fingerprint: FP_IGPU, probe: 'low-power' }),
  },
};

const DISCOVERY_SOFTWARE_ONLY: AdapterDiscovery = {
  adapters: [disc({ fingerprint: FP_SWIFT, isFallbackAdapter: true })],
  probes: { hp: disc({ fingerprint: FP_SWIFT, isFallbackAdapter: true }), lp: null },
};

beforeEach(() => {
  resetGpuChoiceStore();
});

describe('probeAdapters (dual probe + dedupe)', () => {
  it('two distinct adapters → both listed, high-performance first', async () => {
    const d = await probeAdapters(fakeGpu({ hp: DGPU(), lp: IGPU(), bare: DGPU() }));
    expect(d.adapters).toHaveLength(2);
    expect(d.adapters[0].probe).toBe('high-performance');
    expect(d.adapters[0].fingerprint).toBe(FP_DGPU);
    expect(d.adapters[1].probe).toBe('low-power');
    expect(d.probes.hp?.fingerprint).toBe(FP_DGPU);
    expect(d.probes.lp?.fingerprint).toBe(FP_IGPU);
  });

  it('identical fingerprints (Windows collapse) → ONE entry, honest', async () => {
    const d = await probeAdapters(fakeGpu({ hp: IGPU(), lp: IGPU(), bare: IGPU() }));
    expect(d.adapters).toHaveLength(1);
    expect(d.adapters[0].probe).toBe('high-performance');
    expect(d.probes.hp?.fingerprint).toBe(d.probes.lp?.fingerprint);
  });

  it('all probes null → empty list (no fake adapters)', async () => {
    const d = await probeAdapters(fakeGpu({}));
    expect(d.adapters).toHaveLength(0);
    expect(d.probes.hp).toBeNull();
  });

  it('a throwing probe never rejects discovery (one bad slot tolerated)', async () => {
    const d = await probeAdapters(fakeGpu({ throwOnHp: true, lp: IGPU(), bare: IGPU() }));
    expect(d.probes.hp).toBeNull();
    expect(d.adapters.map((a) => a.fingerprint)).toEqual([FP_IGPU]);
  });

  it('F23 adapter without .info still fingerprints and flags limits', async () => {
    const d = await probeAdapters(
      fakeGpu({ hp: fakeAdapter({ noInfo: true, maxBufferSize: 1024 }), lp: null }),
    );
    expect(d.adapters[0].info).toEqual({});
    expect(d.adapters[0].fingerprint).toBe('?|?|?');
    expect(d.adapters[0].maxBufferSize).toBe(1024);
    expect(d.adapters[0].isFallbackAdapter).toBeNull();
  });

  it('bare-only adapter (both preference probes null) is discoverable', async () => {
    const d = await probeAdapters(fakeGpu({ bare: IGPU() }));
    expect(d.adapters).toHaveLength(1);
    expect(d.adapters[0].probe).toBe('default');
  });
});

describe('shared software-adapter flag (tier ↔ list agreement)', () => {
  it('reads the GPUAdapterInfo field (Chrome 136+; legacy attribute gone)', () => {
    expect(readAdapterFallbackFlag(fakeAdapter({ vendor: 'Google', architecture: 'SwiftShader', infoFallback: true }))).toBe(true);
    expect(readAdapterFallbackFlag(DGPU())).toBe(false);
  });

  it('legacy attribute fallback for old Chrome (no info field flag)', () => {
    expect(readAdapterFallbackFlag(fakeAdapter({ legacyFallback: true }))).toBe(true);
    expect(readAdapterFallbackFlag(fakeAdapter({ noInfo: true }))).toBeNull();
  });

  it('detectHardware honors the optional powerPreference argument', async () => {
    const seen: Array<GPURequestAdapterOptions | undefined> = [];
    const gpu = fakeGpu({ hp: DGPU(), lp: IGPU(), bare: DGPU(), seen });
    const hw = await detectHardware(gpu, async () => ({}), 'high-performance');
    expect(seen[0]).toEqual({ powerPreference: 'high-performance' });
    expect(hw.tier).toBe('gpu-strong');
    // Bare default (existing callers) is unchanged.
    const bareSeen: Array<GPURequestAdapterOptions | undefined> = [];
    await detectHardware(fakeGpu({ bare: DGPU(), seen: bareSeen }), async () => ({}));
    expect(bareSeen[0]).toBeUndefined();
  });
});

/* ------------------------------ choice store ------------------------------ */

describe('choice store (localStorage + observable)', () => {
  it('defaults to auto and persists a set choice', () => {
    expect(getGpuChoice()).toBe('auto');
    setGpuChoice({ kind: 'adapter', fingerprint: FP_DGPU });
    expect(getGpuChoice()).toEqual({ kind: 'adapter', fingerprint: FP_DGPU });
    expect(JSON.parse(localStorage.getItem(GPU_CHOICE_KEY)!)).toEqual({
      kind: 'adapter',
      fingerprint: FP_DGPU,
    });
    setGpuChoice({ kind: 'cpu' });
    expect(JSON.parse(localStorage.getItem(GPU_CHOICE_KEY)!)).toEqual({ kind: 'cpu' });
  });

  it('notifies subscribers on change; unsubscribe stops it', () => {
    const seen: GpuChoice[] = [];
    const un = subscribeGpuChoice(() => seen.push(getGpuChoice()));
    setGpuChoice({ kind: 'cpu' });
    un();
    setGpuChoice('auto');
    expect(seen).toEqual([{ kind: 'cpu' }]);
  });

  it('corrupt JSON reads as auto (never crashes)', async () => {
    localStorage.setItem(GPU_CHOICE_KEY, '{not json');
    vi.resetModules();
    const mod = await import('../src/lib/gpu-choice');
    expect(mod.getGpuChoice()).toBe('auto');
  });

  it('invalid shapes read as auto', async () => {
    localStorage.setItem(GPU_CHOICE_KEY, JSON.stringify({ kind: 'adapter' }));
    vi.resetModules();
    const mod = await import('../src/lib/gpu-choice');
    expect(mod.getGpuChoice()).toBe('auto');
  });
});

/* ------------------------------ resolveChoice ----------------------------- */

describe('resolveChoice matrix', () => {
  it('auto → first high-performance non-software adapter', () => {
    const r = resolveChoice('auto', DISCOVERY_DUAL);
    expect(r.resolved).toEqual({ kind: 'gpu', powerPreference: 'high-performance', fingerprint: FP_DGPU });
    expect(r.warning).toBeNull();
  });

  it('auto falls back to low-power, then cpu (software-only machine)', () => {
    const lpOnly: AdapterDiscovery = {
      adapters: [DISCOVERY_DUAL.probes.lp!],
      probes: { hp: null, lp: DISCOVERY_DUAL.probes.lp! },
    };
    expect(resolveChoice('auto', lpOnly).resolved).toEqual({
      kind: 'gpu',
      powerPreference: 'low-power',
      fingerprint: FP_IGPU,
    });
    const r = resolveChoice('auto', DISCOVERY_SOFTWARE_ONLY);
    expect(r.resolved).toEqual({ kind: 'cpu' });
  });

  it('cpu choice → cpu regardless of adapters', () => {
    expect(resolveChoice({ kind: 'cpu' }, DISCOVERY_DUAL).resolved).toEqual({ kind: 'cpu' });
  });

  it('stored adapter → that adapter with its probe slot', () => {
    const r = resolveChoice({ kind: 'adapter', fingerprint: FP_IGPU }, DISCOVERY_DUAL);
    expect(r.resolved).toEqual({ kind: 'gpu', powerPreference: 'low-power', fingerprint: FP_IGPU });
  });

  it('bare-only adapter resolves without a preference (engine requests bare)', () => {
    const bareOnly: AdapterDiscovery = {
      adapters: [disc({ fingerprint: FP_IGPU, probe: 'default' })],
      probes: { hp: null, lp: null },
    };
    expect(resolveChoice('auto', bareOnly).resolved).toEqual({ kind: 'gpu', fingerprint: FP_IGPU });
  });

  it('missing fingerprint (undocked) → auto + warning, never a crash', () => {
    const r = resolveChoice({ kind: 'adapter', fingerprint: 'amd|gone|0' }, DISCOVERY_DUAL);
    expect(r.warning).toBe('missing-adapter');
    expect(r.resolved).toEqual({ kind: 'gpu', powerPreference: 'high-performance', fingerprint: FP_DGPU });
  });

  it('a software adapter is never a valid target', () => {
    const r = resolveChoice({ kind: 'adapter', fingerprint: FP_SWIFT }, DISCOVERY_SOFTWARE_ONLY);
    expect(r.warning).toBe('missing-adapter');
    expect(r.resolved).toEqual({ kind: 'cpu' });
  });
});

/* --------------------------------- labels --------------------------------- */

describe('labels (plain driver strings — SEC-3)', () => {
  it('label parts and software flag', () => {
    expect(gpuChoiceLabel('auto', DISCOVERY_DUAL)).toEqual({ key: 'settings.gpu_auto' });
    expect(gpuChoiceLabel({ kind: 'cpu' }, DISCOVERY_DUAL)).toEqual({ key: 'settings.gpu_cpu' });
    const dgpu = gpuChoiceLabel({ kind: 'adapter', fingerprint: FP_DGPU }, DISCOVERY_DUAL);
    expect(dgpu).toEqual({ key: 'settings.gpu_adapter', label: 'nvidia · ada · 4050', software: false });
  });

  it('missing adapter label keeps the stored fingerprint', () => {
    const label = gpuChoiceLabel({ kind: 'adapter', fingerprint: 'amd|gone|0' }, DISCOVERY_DUAL);
    expect(label).toEqual({ key: 'settings.gpu_missing', label: 'amd|gone|0' });
  });

  it('power class only when the probes disagree', () => {
    expect(adapterPowerClass(DISCOVERY_DUAL, FP_DGPU)).toBe('maybe-discrete');
    expect(adapterPowerClass(DISCOVERY_DUAL, FP_IGPU)).toBe('likely-integrated');
    const collapsed: AdapterDiscovery = {
      adapters: [],
      probes: {
        hp: disc({ fingerprint: FP_IGPU }),
        lp: disc({ fingerprint: FP_IGPU, probe: 'low-power' }),
      },
    };
    expect(adapterPowerClass(collapsed, FP_IGPU)).toBe('unknown');
  });
});
