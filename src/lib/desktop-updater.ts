/*
 * Desktop updater (phase 3, D5/R10): the Tauri updater plugin — check()
 * against the latest.json channel (releases/latest is desktop-only because
 * web releases are cut with --latest=false), downloadAndInstall with
 * progress, then relaunch. Windows (R10): the NSIS installer KILLS the
 * running app mid-install, so relaunch() is fire-and-forget there — the
 * process usually dies before it returns and the installer restarts the app;
 * the UI copy says so instead of awaiting.
 */

export type DesktopUpdatePhase =
  | 'idle'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'error';

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  /** 0-100 while `downloading`. */
  percent: number | null;
}

export function isWindows(): boolean {
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
}

/**
 * Full install flow with progress reporting. Resolves only on the mac/Linux
 * path (after relaunch settles); on Windows it typically never resolves —
 * the installer replaced the process. Never throws.
 */
export async function runDesktopUpdateFlow(
  onState: (state: DesktopUpdateState) => void,
): Promise<void> {
  const { check } = await import('@tauri-apps/plugin-updater');
  const { relaunch } = await import('@tauri-apps/plugin-process');
  try {
    const update = await check();
    if (!update) {
      onState({ phase: 'idle', percent: null });
      return;
    }
    let received = 0;
    let total = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0;
        received = 0;
        onState({ phase: 'downloading', percent: total > 0 ? 0 : null });
      } else if (event.event === 'Progress') {
        received += event.data.chunkLength;
        onState({
          phase: 'downloading',
          percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null,
        });
      } else if (event.event === 'Finished') {
        onState({ phase: 'installing', percent: null });
      }
    });
    onState({ phase: 'restarting', percent: null });
    if (isWindows()) {
      // R10: NSIS kills the running app — do NOT await (relaunch may never
      // resolve); the installer restarts the app by itself.
      void relaunch();
    } else {
      await relaunch();
    }
  } catch {
    onState({ phase: 'error', percent: null });
  }
}
