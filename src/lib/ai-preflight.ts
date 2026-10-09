import { probeAdapters, resolveCurrentChoice } from './gpu-choice';

/*
 * AI preflight heuristics (plan 261009-0836 phase 3). Before the engine
 * loads, estimate whether the CHOSEN target can hold the model + inference
 * peak. When the estimate is tight the app ASKS the user (reduced mode vs
 * run-full) — never decides for them ("biết đâu họ muốn đánh đổi chạy
 * chậm"). Both proxies are coarse: iGPU shared memory makes maxBufferSize
 * reflect system RAM, so every VRAM figure is an ESTIMATE and the UI says
 * so.
 *
 * Constants from the v0.5.0 SPIKE: the model is ~652MB on disk and the
 * process peaked at ~4GB at 1024px (capability MIN_RAM_GB / STRONG_RAM_GB).
 */

export const FULL_PEAK_GB = 4;
export const MODEL_DISK_GB = 0.652;

/** The reduced preset trades quality for headroom (768px, capped tokens). */
export interface AiTuning {
  maxLongEdge: 768 | 1024;
  maxNewTokens: 2048 | 4096;
}

export const AI_TUNING_PRESETS = {
  full: { maxLongEdge: 1024, maxNewTokens: 4096 },
  reduced: { maxLongEdge: 768, maxNewTokens: 2048 },
} as const satisfies Record<string, AiTuning>;

export interface AiFootprintEstimate {
  predictedPeakGB: number;
  /** Which proxy bound the estimate:
   *  - 'vram-limit': the adapter's maxBufferSize (GPU-side, shared-memory coarse)
   *  - 'ram-hint':   navigator.deviceMemory (GB hint, Chrome-only)
   *  - 'default':    no hints — optimistic, no ask. */
  basis: 'vram-limit' | 'ram-hint' | 'default';
  tight: boolean;
}

/** Adapter record shape phase 1's discovery provides (structural for tests). */
export interface PreflightAdapter {
  maxBufferSize: number | null;
}

export function estimateAiFootprint(
  adapter: PreflightAdapter | 'cpu',
  deviceMemoryGB: number | null,
): AiFootprintEstimate {
  // Exactly-4GB counts as tight: the SPIKE's ~4GB peak leaves no headroom
  // for the OS on a 4GB machine (the tier ladder's MIN_RAM_GB is the same
  // boundary — below it is cpu-tier, at it there is no margin).
  const isTight = (bindingGB: number): boolean => bindingGB <= FULL_PEAK_GB;
  if (adapter === 'cpu') {
    if (deviceMemoryGB === null) {
      return { predictedPeakGB: FULL_PEAK_GB, basis: 'default', tight: false };
    }
    return { predictedPeakGB: FULL_PEAK_GB, basis: 'ram-hint', tight: isTight(deviceMemoryGB) };
  }
  const vramGB = adapter.maxBufferSize !== null ? adapter.maxBufferSize / 1024 ** 3 : null;
  if (vramGB !== null && deviceMemoryGB !== null) {
    // The binding proxy is the SMALLER hint — on an iGPU maxBufferSize is
    // shared-memory (small), on a dGPU the RAM hint may bind instead.
    const binding = Math.min(vramGB, deviceMemoryGB);
    return {
      predictedPeakGB: FULL_PEAK_GB,
      basis: binding === vramGB ? 'vram-limit' : 'ram-hint',
      tight: isTight(binding),
    };
  }
  if (vramGB !== null) {
    return { predictedPeakGB: FULL_PEAK_GB, basis: 'vram-limit', tight: isTight(vramGB) };
  }
  if (deviceMemoryGB !== null) {
    return { predictedPeakGB: FULL_PEAK_GB, basis: 'ram-hint', tight: isTight(deviceMemoryGB) };
  }
  return { predictedPeakGB: FULL_PEAK_GB, basis: 'default', tight: false };
}

/**
 * Live estimate for the CURRENTLY stored choice (config step + resume).
 * CPU choice → RAM-hint basis; a GPU choice → that adapter's record.
 */
export async function estimateForCurrentChoice(): Promise<AiFootprintEstimate> {
  const deviceMemoryGB =
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null;
  try {
    const discovery = await probeAdapters();
    const { resolved } = resolveCurrentChoice(discovery);
    if (resolved.kind === 'cpu') {
      return estimateAiFootprint('cpu', deviceMemoryGB);
    }
    const adapter = discovery.adapters.find((a) => a.fingerprint === resolved.fingerprint);
    if (!adapter) return estimateAiFootprint('cpu', deviceMemoryGB);
    return estimateAiFootprint({ maxBufferSize: adapter.maxBufferSize }, deviceMemoryGB);
  } catch {
    // No WebGPU surface at all — the engine will run CPU-side.
    return estimateAiFootprint('cpu', deviceMemoryGB);
  }
}
