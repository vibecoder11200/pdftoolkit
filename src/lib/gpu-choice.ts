/*
 * WebGPU adapter discovery + persisted GPU choice (plan 261009-0836 phase 1,
 * GPU-selection). The single source of truth every later phase consumes:
 * engine apply (phase 2), diagnostics + benchmark identity (phase 4),
 * preflight (phase 3).
 *
 * Discovery runs BOTH powerPreference probes (+ the bare default for tier
 * parity) and dedupes by fingerprint — on machines where Windows/Chromium
 * collapses both probes to one adapter (observed on this dev machine:
 * crbug.com/369219127 ignores powerPreference on Windows) the UI honestly
 * shows ONE adapter instead of a fake choice. Software adapters (SwiftShader)
 * are never auto-selected; they stay in the list, clearly labeled.
 *
 * The choice persists in localStorage and lives in a module-level observable
 * store (pattern: desktop-update-store.ts) so the OCR status line and the
 * Settings panel re-render on change without an app restart.
 */
import {
  adapterFingerprint,
  readAdapterFallbackFlag,
  readAdapterInfo,
  type AdapterInfo,
} from './capability';

export type PowerPreference = 'high-performance' | 'low-power';

export interface DiscoveredAdapter {
  /** First probe slot that returned this adapter (dedupe keeps the first). */
  probe: PowerPreference | 'default';
  info: AdapterInfo;
  fingerprint: string;
  isFallbackAdapter: boolean | null;
  maxBufferSize: number | null;
}

export interface AdapterDiscovery {
  /** Deduped; deterministic order: high-performance first, then low-power,
   *  then bare-only. Includes software adapters (labeled by the flag). */
  adapters: DiscoveredAdapter[];
  /** Per-probe outcome for the diagnostics table (phase 4). */
  probes: { hp: DiscoveredAdapter | null; lp: DiscoveredAdapter | null };
}

/**
 * User's persisted choice: automatic (prefer the discrete card), a specific
 * adapter fingerprint, or forced CPU (wasm).
 */
export type GpuChoice =
  | 'auto'
  | { kind: 'adapter'; fingerprint: string }
  | { kind: 'cpu' };

export type ResolvedGpuChoice =
  | {
      kind: 'gpu';
      /** The probe slot to re-request in the engine. `undefined` only for an
       *  adapter reachable bare-only (both preference probes null). */
      powerPreference?: PowerPreference;
      fingerprint: string;
    }
  | { kind: 'cpu' };

export interface ResolvedWithWarning {
  resolved: ResolvedGpuChoice;
  /** Set when a stored fingerprint no longer exists (undocked, driver
   *  change) — auto rules applied instead, never a crash. */
  warning: 'missing-adapter' | null;
}

function toDiscovered(
  adapter: GPUAdapter,
  probe: PowerPreference | 'default',
): DiscoveredAdapter {
  const info = readAdapterInfo(adapter);
  return {
    probe,
    info,
    fingerprint: adapterFingerprint(info),
    isFallbackAdapter: readAdapterFallbackFlag(adapter),
    maxBufferSize: adapter.limits?.maxBufferSize ?? null,
  };
}

/**
 * Dual-preference probe + bare default, deduped by fingerprint. All three
 * run even when one returns null (the diagnostics table shows every probe).
 */
export async function probeAdapters(
  gpu: Navigator['gpu'] | undefined = (navigator as Navigator & { gpu?: Navigator['gpu'] }).gpu,
): Promise<AdapterDiscovery> {
  const empty: AdapterDiscovery = {
    adapters: [],
    probes: { hp: null, lp: null },
  };
  if (!gpu) return empty;

  const results: Record<'hp' | 'lp' | 'bare', DiscoveredAdapter | null> = {
    hp: null,
    lp: null,
    bare: null,
  };
  const requests: Array<{ slot: 'hp' | 'lp' | 'bare'; pref?: PowerPreference }> = [
    { slot: 'hp', pref: 'high-performance' },
    { slot: 'lp', pref: 'low-power' },
    { slot: 'bare', pref: undefined },
  ];
  const probeTagOf = (slot: 'hp' | 'lp' | 'bare'): PowerPreference | 'default' =>
    slot === 'hp' ? 'high-performance' : slot === 'lp' ? 'low-power' : 'default';
  await Promise.all(
    requests.map(async ({ slot, pref }) => {
      try {
        const adapter = await gpu.requestAdapter(pref ? { powerPreference: pref } : undefined);
        results[slot] = adapter ? toDiscovered(adapter, probeTagOf(slot)) : null;
      } catch {
        results[slot] = null;
      }
    }),
  );

  // Dedupe by fingerprint, FIRST occurrence's slot kept: hp → lp → bare.
  const seen = new Map<string, DiscoveredAdapter>();
  for (const key of ['hp', 'lp', 'bare'] as const) {
    const found = results[key];
    if (found && !seen.has(found.fingerprint)) seen.set(found.fingerprint, found);
  }
  return {
    adapters: [...seen.values()],
    probes: { hp: results.hp, lp: results.lp },
  };
}

/* ------------------------------ choice store ------------------------------ */

export const GPU_CHOICE_KEY = 'pdftoolkit-ai-gpu';

function isValidChoice(value: unknown): value is GpuChoice {
  if (value === 'auto') return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; fingerprint?: unknown };
  if (v.kind === 'adapter') return typeof v.fingerprint === 'string' && v.fingerprint.length > 0;
  if (v.kind === 'cpu') return true;
  return false;
}

function readStoredChoice(): GpuChoice {
  try {
    const raw = localStorage.getItem(GPU_CHOICE_KEY);
    if (!raw) return 'auto';
    const parsed: unknown = JSON.parse(raw);
    return isValidChoice(parsed) ? parsed : 'auto';
  } catch {
    return 'auto';
  }
}

let cachedChoice: GpuChoice = typeof localStorage === 'undefined' ? 'auto' : readStoredChoice();
const listeners = new Set<() => void>();

/** useSyncExternalStore snapshot — stable reference between sets. */
export function getGpuChoice(): GpuChoice {
  return cachedChoice;
}

export function setGpuChoice(choice: GpuChoice): void {
  cachedChoice = choice;
  try {
    localStorage.setItem(GPU_CHOICE_KEY, JSON.stringify(choice));
  } catch {
    /* private mode — the in-memory choice still applies for this session */
  }
  for (const listener of listeners) listener();
}

export function subscribeGpuChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam — suites must start from the default. */
export function resetGpuChoiceStore(): void {
  cachedChoice = 'auto';
  try {
    localStorage.removeItem(GPU_CHOICE_KEY);
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener();
}

/* ------------------------------- resolution ------------------------------- */

function isSoftware(adapter: DiscoveredAdapter): boolean {
  return adapter.isFallbackAdapter === true;
}

/**
 * Choice + discovery → the concrete engine request. 'auto' resolves to the
 * first high-performance non-software adapter, falling back to low-power,
 * then CPU. A stored fingerprint that no longer exists (or turned out
 * software) resolves to auto WITH the warning flag — the UI surfaces it.
 */
export function resolveChoice(choice: GpuChoice, discovery: AdapterDiscovery): ResolvedWithWarning {
  const autoResolve = (): ResolvedGpuChoice => {
    const hp = discovery.probes.hp;
    if (hp && !isSoftware(hp)) return { kind: 'gpu', powerPreference: 'high-performance', fingerprint: hp.fingerprint };
    const lp = discovery.probes.lp;
    if (lp && !isSoftware(lp)) return { kind: 'gpu', powerPreference: 'low-power', fingerprint: lp.fingerprint };
    // Bare-only adapter (both preference probes null): still usable — the
    // engine re-requests bare, the same slot that discovered it.
    const bareOnly = discovery.adapters.find((a) => !isSoftware(a));
    if (bareOnly) return { kind: 'gpu', fingerprint: bareOnly.fingerprint };
    return { kind: 'cpu' };
  };

  if (choice === 'auto') return { resolved: autoResolve(), warning: null };
  if (choice.kind === 'cpu') return { resolved: { kind: 'cpu' }, warning: null };

  const found = discovery.adapters.find(
    (a) => a.fingerprint === choice.fingerprint && !isSoftware(a),
  );
  if (!found) return { resolved: autoResolve(), warning: 'missing-adapter' };
  const pref =
    found.probe === 'high-performance' || found.probe === 'low-power' ? found.probe : undefined;
  return {
    resolved: { kind: 'gpu', ...(pref ? { powerPreference: pref } : {}), fingerprint: found.fingerprint },
    warning: null,
  };
}

/** The effective request for the CURRENTLY stored choice. */
export function resolveCurrentChoice(discovery: AdapterDiscovery): ResolvedWithWarning {
  return resolveChoice(getGpuChoice(), discovery);
}

/** Structural equality (the UI drafts choices as fresh objects). */
export function gpuChoiceEquals(a: GpuChoice, b: GpuChoice): boolean {
  if (a === 'auto' || b === 'auto') return a === b;
  return a.kind === b.kind && (a.kind !== 'adapter' || a.fingerprint === (b as { fingerprint: string }).fingerprint);
}

/* --------------------------------- labels --------------------------------- */

/** Plain driver strings only (SEC-3): adapter-reported fields never render
 *  as HTML — the UI interpolates them as React text nodes. */
export function adapterDisplayLabel(adapter: DiscoveredAdapter): string {
  const parts = [adapter.info.vendor, adapter.info.architecture, adapter.info.device].filter(
    (v): v is string => Boolean(v),
  );
  if (parts.length > 0) return parts.join(' · ');
  return adapter.info.description || adapter.fingerprint;
}

/** i18n key parts for a choice — the UI maps them through t(). */
export type GpuChoiceLabel =
  | { key: 'settings.gpu_auto' }
  | { key: 'settings.gpu_cpu' }
  | { key: 'settings.gpu_adapter'; label: string; software: boolean }
  | { key: 'settings.gpu_missing'; label: string };

export function gpuChoiceLabel(choice: GpuChoice, discovery: AdapterDiscovery): GpuChoiceLabel {
  if (choice === 'auto') return { key: 'settings.gpu_auto' };
  if (choice.kind === 'cpu') return { key: 'settings.gpu_cpu' };
  const found = discovery.adapters.find((a) => a.fingerprint === choice.fingerprint);
  const label = found ? adapterDisplayLabel(found) : choice.fingerprint;
  if (!found) return { key: 'settings.gpu_missing', label };
  return { key: 'settings.gpu_adapter', label, software: isSoftware(found) };
}

/**
 * Estimated class for the "onboard / rời (ước tính)" tag: ONLY when both
 * probes returned distinct adapters does a slot imply a power class (hp slot
 * ≠ lp slot fingerprint → the hp one is "khả năng là card rời"). A collapsed
 * single adapter says nothing — the honest label is none.
 */
export type AdapterPowerClass = 'maybe-discrete' | 'likely-integrated' | 'unknown';

export function adapterPowerClass(
  discovery: AdapterDiscovery,
  fingerprint: string,
): AdapterPowerClass {
  const { hp, lp } = discovery.probes;
  if (!hp || !lp || hp.fingerprint === lp.fingerprint) return 'unknown';
  if (fingerprint === hp.fingerprint) return 'maybe-discrete';
  if (fingerprint === lp.fingerprint) return 'likely-integrated';
  return 'unknown';
}
