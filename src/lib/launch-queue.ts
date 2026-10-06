/*
 * PWA file-handling launch consumer (`window.launchQueue`). Only Chromium
 * implements it — feature-detect and no-op everywhere else (Safari/Firefox
 * open PDFs in their normal viewer; no console noise).
 *
 * Routing policy (red-team #9): the manifest declares focus-existing, so a
 * launch must never blow away an in-progress session. Files are parked in
 * the handoff either way; the home page picks them up reactively (suggestion
 * sheet), while a tool page shows the launch banner instead of navigating.
 */

type LaunchParams = { files?: { getFile(): Promise<File> }[] };
type LaunchQueue = { setConsumer(consumer: (params: LaunchParams) => void): void };

export type LaunchRoute = 'home' | 'tool';

/** Pure routing decision, unit-testable without a router. */
export function routeForLaunch(pathname: string): LaunchRoute {
  return pathname === '/' ? 'home' : 'tool';
}

export function initLaunchQueue(onFiles: (files: File[]) => void): void {
  const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
  if (!queue || typeof queue.setConsumer !== 'function') return;
  queue.setConsumer((params) => {
    void (async () => {
      const files: File[] = [];
      for (const handle of params?.files ?? []) {
        try {
          files.push(await handle.getFile());
        } catch {
          /* handle revoked between launch and read — skip it */
        }
      }
      if (files.length > 0) onFiles(files);
    })();
  });
}
