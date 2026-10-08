/*
 * App-wide in-flight job registry (v0.5.0 phase 6, red-team F22): a desktop
 * update restarts the app, which would silently kill any long-running tool
 * job (OCR pages are seconds-scale, AI OCR sessions tens of minutes). Tools
 * bracket their work with beginJob/endJob; the update banner reads
 * hasActiveJob and asks for confirmation before starting the install.
 *
 * React components read the registry through useActiveJob() (see
 * hooks/use-active-job.ts) — a version counter turns begin/end into store
 * notifications, because a bare boolean read at render time missed jobs that
 * started after the last render (review P2-8: the F22 confirm could be
 * skipped exactly when it mattered).
 */
const active = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function beginJob(id: string): void {
  if (active.has(id)) return;
  active.add(id);
  notify();
}

export function endJob(id: string): void {
  if (!active.delete(id)) return;
  notify();
}

export function hasActiveJob(): boolean {
  return active.size > 0;
}

/** useSyncExternalStore plumbing — this module stays React-free. */
export function subscribeActiveJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActiveJobsVersion(): number {
  return version;
}
