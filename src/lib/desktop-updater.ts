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
  /** Manual/auto check in flight (desktop-update-store) — never shown by the banner. */
  | 'checking'
  /** Manual check found nothing newer — Settings-local state. */
  | 'uptodate'
  /** Manual check failed (offline, endpoint) — Settings-local state. */
  | 'check-error'
  | 'available'
  /** Synchronous click feedback, before the plugin module finishes importing. */
  | 'starting'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'error';

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  /** 0-100 while `downloading`. */
  percent: number | null;
  /** Failure detail for `error`/`check-error` — surfaced with a Retry button (phase 6, F7). */
  message?: string;
  /** Remote version for `available` (the plugin's update.version, when reported). */
  availableVersion?: string;
  /** Epoch ms of the last completed check — "checked N minutes ago" in Settings. */
  lastCheckedAt?: number;
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
  } catch (err) {
    // F7: the catch must not swallow the failure — the banner shows the
    // message with a Retry button. (Cancel-vs-network classification is not
    // possible: the plugin API has no cancel and errors carry no code.)
    onState({
      phase: 'error',
      percent: null,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
