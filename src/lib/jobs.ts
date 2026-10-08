/*
 * App-wide in-flight job registry (v0.5.0 phase 6, red-team F22): a desktop
 * update restarts the app, which would silently kill any long-running tool
 * job (OCR pages are seconds-scale, AI OCR sessions tens of minutes). Tools
 * bracket their work with beginJob/endJob; the update banner reads
 * hasActiveJob and asks for confirmation before starting the install.
 */
const active = new Set<string>();

export function beginJob(id: string): void {
  active.add(id);
}

export function endJob(id: string): void {
  active.delete(id);
}

export function hasActiveJob(): boolean {
  return active.size > 0;
}
