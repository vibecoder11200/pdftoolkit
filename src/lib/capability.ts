/*
 * Capability gate (v0.5.0 phase 3, D4): the 5-tier ladder for the AI OCR
 * engine label.
 *
 *  T1  navigator.gpu present?
 *  T2  requestAdapter() → fallback (software) adapter means CPU tier
 *  T3  adapter.info (OPTIONAL-CHAIN — Chrome 113-122 lacks .info, F23) +
 *      limits.maxBufferSize split GPU-strong / GPU-weak
 *  T4  navigator.deviceMemory hint + storage headroom (≥1.2× model, the
 *      shared pre-flight from phase 2a) — RAM gates the ~4GB process peak
 *      the SPIKE measured
 *  T5  benchmark-on-first-use: warmup generate DISCARDED, then one measured
 *      pass (shader-compile pollution protocol, F17); the record persists
 *      PER MODEL keyed with the adapter fingerprint — a driver/GPU switch
 *      invalidates it. Resolution order: fresh benchmark > estimate; the UI
 *      must distinguish "đã đo" from "ước tính".
 *
 * Everything is SURFACED, never hidden (D4): a red/none tier still lets the
 * user press the button behind a warning; tesseract is the suggested tier
 * when AI is red.
 */
import { openBenchmarkDb, type IDBDatabaseLike } from './idb-benchmarks';

export type CapabilityTier = 'gpu-strong' | 'gpu-weak' | 'cpu' | 'none';

export interface AdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

export interface HardwareInfo {
  webgpu: boolean;
  adapter: AdapterInfo | null;
  isFallbackAdapter: boolean | null;
  /** navigator.deviceMemory hint, Chrome-only (GB). null when absent. */
  deviceMemoryGB: number | null;
  maxBufferSize: number | null;
  /** T4 storage estimate — label context only (the hard gate is the 2a preflight). */
  storage: { usage?: number; quota?: number } | null;
  tier: CapabilityTier;
  tierSource: 'estimate';
}

/** navigator.deviceMemory is a Chrome hint outside the standard lib types. */
function deviceMemoryHint(): number | null {
  const v = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof v === 'number' ? v : null;
}

const MIN_BUFFER_GPU_STRONG = 2 * 1024 ** 3; // 2 GiB
const MIN_BUFFER_GPU_WEAK = 1 * 1024 ** 3; // 1 GiB
const MIN_RAM_GB = 4; // the SPIKE measured a ~4GB process peak — below this, no AI
const STRONG_RAM_GB = 8;

export function adapterFingerprint(info: AdapterInfo | null): string {
  return [info?.vendor ?? '?', info?.architecture ?? '?', info?.device ?? '?'].join('|');
}

/**
 * F23: .info is optional — old Chrome exposes neither the attribute nor
 * accessors; feature-detect every key. Shared by the tier ladder and
 * gpu-choice discovery so both describe the same machine identically.
 */
export function readAdapterInfo(adapter: GPUAdapter): AdapterInfo {
  const info: AdapterInfo = {};
  const rawInfo = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  if (rawInfo) {
    for (const key of ['vendor', 'architecture', 'device', 'description'] as const) {
      try {
        const v = rawInfo[key];
        if (v) info[key] = String(v);
      } catch {
        /* accessor absent */
      }
    }
  }
  return info;
}

/**
 * Software-adapter (SwiftShader) flag: `adapter.info.isFallbackAdapter`
 * (GPUAdapterInfo field, Chrome 136+) with the legacy `adapter` attribute as
 * fallback — the attribute was REMOVED in Chrome 140 (R2 Q4), so a bare
 * legacy read is undefined on current Chrome and the tier ladder's
 * `isFallback === true → 'cpu'` gate was dead code. Shared by detectHardware
 * and gpu-choice — the tier label and the adapter list must never disagree.
 */
export function readAdapterFallbackFlag(adapter: GPUAdapter): boolean | null {
  const rawInfo = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  if (rawInfo) {
    try {
      const v = (rawInfo as GPUAdapterInfo & { isFallbackAdapter?: boolean }).isFallbackAdapter;
      if (typeof v === 'boolean') return v;
    } catch {
      /* accessor absent */
    }
  }
  const legacy = (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter;
  return typeof legacy === 'boolean' ? legacy : null;
}

/** Tiers 1-4 — pure estimate, no model run involved. */
export async function detectHardware(
  gpu: Navigator['gpu'] | undefined = (navigator as Navigator & { gpu?: Navigator['gpu'] }).gpu,
  storageEstimate: () => Promise<{ usage?: number; quota?: number }> = async () => {
    const est = await navigator.storage?.estimate?.();
    return { usage: est?.usage, quota: est?.quota };
  },
  powerPreference?: GPURequestAdapterOptions['powerPreference'],
): Promise<HardwareInfo> {
  const deviceMemoryGB = deviceMemoryHint();
  let storage: { usage?: number; quota?: number } | null = null;
  try {
    storage = await storageEstimate();
  } catch {
    storage = null;
  }
  const base = {
    deviceMemoryGB,
    storage,
    adapter: null as AdapterInfo | null,
    isFallbackAdapter: null as boolean | null,
    maxBufferSize: null as number | null,
    tier: 'none' as CapabilityTier,
    tierSource: 'estimate' as const,
  };
  if (!gpu) return { ...base, webgpu: false };
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await gpu.requestAdapter(powerPreference ? { powerPreference } : undefined);
  } catch {
    adapter = null;
  }
  if (!adapter) return { ...base, webgpu: true, tier: 'none' };
  const info = readAdapterInfo(adapter);
  const isFallback = readAdapterFallbackFlag(adapter);
  const maxBufferSize = adapter.limits?.maxBufferSize ?? null;

  let tier: CapabilityTier;
  if (isFallback === true) tier = 'cpu';
  else if (deviceMemoryGB !== null && deviceMemoryGB < MIN_RAM_GB) tier = 'cpu';
  else if (maxBufferSize !== null && maxBufferSize >= MIN_BUFFER_GPU_STRONG && (deviceMemoryGB === null || deviceMemoryGB >= STRONG_RAM_GB)) tier = 'gpu-strong';
  else if (maxBufferSize !== null && maxBufferSize >= MIN_BUFFER_GPU_WEAK) tier = 'gpu-weak';
  else tier = 'cpu';

  return {
    webgpu: true,
    adapter: info,
    isFallbackAdapter: isFallback,
    deviceMemoryGB,
    maxBufferSize,
    storage,
    tier,
    tierSource: 'estimate',
  };
}

/* ------------------------------- T5 benchmark ------------------------------ */

export interface BenchmarkRecord {
  modelId: string;
  /** Decode throughput of the MEASURED pass (warmup discarded). */
  tokPerSecWarm: number;
  firstTokenColdMs: number | null;
  condition: 'webgpu' | 'wasm';
  measuredAt: number;
  adapterFingerprint: string;
}

export interface BenchmarkStore {
  /** Nested by modelId then adapter fingerprint (v2 keys, phase 4):
   *  `benchmark/v2/{modelId}/{adapterFingerprint}` — measurements of
   *  DIFFERENT adapters coexist instead of overwriting each other. Legacy
   *  flat `benchmark/{modelId}` rows are MIGRATED (one-shot, at open) to
   *  `v2/{modelId}/{rec.adapterFingerprint}` — never dropped. */
  loadAll(): Promise<Record<string, Record<string, BenchmarkRecord>>>;
  save(rec: BenchmarkRecord): Promise<void>;
}

const V2_PREFIX = 'benchmark/v2/';
const LEGACY_PREFIX = 'benchmark/';
const v2KeyOf = (modelId: string, fingerprint: string) => `${V2_PREFIX}${modelId}/${fingerprint}`;

export function createBenchmarkStore(
  db: Promise<IDBDatabaseLike> = openBenchmarkDb(),
): BenchmarkStore {
  return {
    async loadAll() {
      try {
        const conn = await db;
        const keys = await conn.getAllKeys();
        const out: Record<string, Record<string, BenchmarkRecord>> = {};
        for (const k of keys) {
          if (k.startsWith(V2_PREFIX)) {
            const rest = k.slice(V2_PREFIX.length);
            const slash = rest.indexOf('/');
            if (slash <= 0) continue;
            const modelId = rest.slice(0, slash);
            const fingerprint = rest.slice(slash + 1);
            const rec = (await conn.get(k)) as BenchmarkRecord | undefined;
            if (rec) {
              (out[modelId] ??= {})[fingerprint] = rec;
            }
          }
        }
        // One-shot legacy migration: each old record moves to the v2 key
        // derived from its own adapterFingerprint (present on every record
        // since phase 4a) — old measurements survive, no re-measure tax.
        for (const k of keys) {
          if (!k.startsWith(LEGACY_PREFIX) || k.startsWith(V2_PREFIX)) continue;
          try {
            const rec = (await conn.get(k)) as BenchmarkRecord | undefined;
            if (!rec?.adapterFingerprint) continue;
            const modelId = k.slice(LEGACY_PREFIX.length);
            await conn.put(rec, v2KeyOf(modelId, rec.adapterFingerprint));
            await conn.delete(k);
            (out[modelId] ??= {})[rec.adapterFingerprint] = rec;
          } catch {
            /* a half-migrated row stays estimate-only — honest UI */
          }
        }
        return out;
      } catch {
        return {}; // no IDB (private mode) → estimate-only tiering, honest UI
      }
    },
    async save(rec) {
      const conn = await db;
      await conn.put(rec, v2KeyOf(rec.modelId, rec.adapterFingerprint));
    },
  };
}

export function isBenchmarkStale(rec: BenchmarkRecord, fingerprint: string): boolean {
  return rec.adapterFingerprint !== fingerprint;
}

export interface TierResolution {
  tier: CapabilityTier;
  source: 'measured' | 'estimate';
  /** Present when source = measured. */
  benchmark?: BenchmarkRecord;
  stale?: boolean;
}

/** Resolution order (F17): fresh benchmark > estimate. */
export function resolveTier(hardware: HardwareInfo, benchmark: BenchmarkRecord | undefined): TierResolution {
  if (benchmark && !isBenchmarkStale(benchmark, adapterFingerprint(hardware.adapter))) {
    // A measured record reclassifies the ESTIMATE tier in BOTH directions.
    // Thresholds from the SPIKE (iGPU ≈ 12-16 tok/s ≈ 40-60s/page):
    // ≥60 strong · ≥12 weak · below that the CPU tier is the honest label.
    const t = benchmark.tokPerSecWarm;
    const tier: CapabilityTier = t >= 60 ? 'gpu-strong' : t >= 12 ? 'gpu-weak' : 'cpu';
    return { tier, source: 'measured', benchmark };
  }
  return {
    tier: hardware.tier,
    source: 'estimate',
    benchmark,
    stale: benchmark !== undefined,
  };
}

/**
 * F17 protocol: warmup generate DISCARDED (shader compile), then ONE
 * measured pass. The executor is injected (the worker engine in production,
 * a fake in tests).
 */
export interface BenchmarkExecutor {
  generate(image: { width: number; height: number }, maxNewTokens: number): Promise<{
    genTokens: number;
    ms: number;
    firstTokenMs: number | null;
  }>;
}

/** Persist a measured record derived from a real page run (phase 4a). */
export async function saveBenchmarkRecord(
  modelId: string,
  condition: 'webgpu' | 'wasm',
  fingerprint: string,
  tokPerSecWarm: number,
  firstTokenColdMs: number | null,
  store: BenchmarkStore,
): Promise<BenchmarkRecord> {
  const rec: BenchmarkRecord = {
    modelId,
    tokPerSecWarm,
    firstTokenColdMs,
    condition,
    measuredAt: Date.now(),
    adapterFingerprint: fingerprint,
  };
  await store.save(rec);
  return rec;
}

export async function runBenchmark(
  modelId: string,
  condition: 'webgpu' | 'wasm',
  fingerprint: string,
  executor: BenchmarkExecutor,
  store: BenchmarkStore,
): Promise<BenchmarkRecord> {
  await executor.generate({ width: 256, height: 256 }, 16); // warmup — discarded
  const measured = await executor.generate({ width: 256, height: 256 }, 64);
  const rec: BenchmarkRecord = {
    modelId,
    tokPerSecWarm: +((measured.genTokens / measured.ms) * 1000).toFixed(2),
    firstTokenColdMs: measured.firstTokenMs,
    condition,
    measuredAt: Date.now(),
    adapterFingerprint: fingerprint,
  };
  await store.save(rec);
  return rec;
}

/** Human-facing summary for the Settings hardware panel (phase 5 renders). */
export async function getHardwareInfo(
  store: BenchmarkStore = createBenchmarkStore(),
): Promise<{
  hardware: HardwareInfo;
  /** Nested: perModel[modelId][adapterFingerprint] — per-adapter records
   *  coexist (v2 keys); resolveTier against the CURRENT adapter decides
   *  measured-vs-stale per row. */
  perModel: Record<string, Record<string, TierResolution>>;
}> {
  const hardware = await detectHardware();
  const benchmarks = await store.loadAll();
  const perModel: Record<string, Record<string, TierResolution>> = {};
  for (const [modelId, perFingerprint] of Object.entries(benchmarks)) {
    perModel[modelId] = Object.fromEntries(
      Object.entries(perFingerprint).map(([fp, rec]) => [fp, resolveTier(hardware, rec)] as const),
    );
  }
  return { hardware, perModel };
}
