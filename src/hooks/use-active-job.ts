import { useSyncExternalStore } from 'react';
import { hasActiveJob, subscribeActiveJobs } from '../lib/jobs';

/**
 * Reactive hasActiveJob() — re-renders the consumer whenever a job begins or
 * ends. Render-time hasActiveJob() calls went stale between renders, letting
 * a desktop update start over an in-flight tool job without the F22 confirm
 * (review P2-8).
 */
export function useActiveJob(): boolean {
  return useSyncExternalStore(subscribeActiveJobs, hasActiveJob, () => false);
}
