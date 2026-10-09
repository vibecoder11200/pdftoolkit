import { useSyncExternalStore } from 'react';
import { getGpuChoice, subscribeGpuChoice } from '../lib/gpu-choice';

/** Subscribe the persisted GPU choice (phase-1 observable store). */
export function useGpuChoice() {
  return useSyncExternalStore(subscribeGpuChoice, getGpuChoice);
}
