/*
 * GPU-fallback notification store (plan 261009-0836 phase 2): the client's
 * fallback chain (dGPU→iGPU→CPU) reports every transition here; the OCR tool
 * and Settings subscribe (pattern: desktop-update-store.ts) and show
 * "Đang chạy trên {adapter/CPU} — {lý do}". Module-level observable — one
 * chain, many surfaces.
 */

export interface GpuFallbackInfo {
  /** Adapter fingerprint (or 'cpu') that was in play before the transition. */
  from: string;
  /** Adapter fingerprint (or 'cpu') running now. */
  to: string;
  /** Raw failure reason the chain reacted to (driver strings, plain text). */
  reason: string;
  at: number;
}

let state: GpuFallbackInfo | null = null;
const listeners = new Set<() => void>();

export function getGpuFallback(): GpuFallbackInfo | null {
  return state;
}

export function subscribeGpuFallback(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function setGpuFallback(info: GpuFallbackInfo): void {
  state = info;
  notify();
}

/** Test seam — suites must start from null. */
export function resetGpuFallbackStore(): void {
  state = null;
  notify();
}
