import { useSyncExternalStore } from 'react';
import { getGpuFallback, subscribeGpuFallback } from '../lib/gpu-fallback-store';

/** Subscribe the GPU fallback chain notifications (phase-2 store). */
export function useGpuFallback() {
  return useSyncExternalStore(subscribeGpuFallback, getGpuFallback);
}
