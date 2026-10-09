import { isTauri } from './platform';
import { runDesktopUpdateFlow, type DesktopUpdateState } from './desktop-updater';

/*
 * Shared desktop-update state (v0.5.3 manual check): the updater phases used
 * to live in a hook-local useState owned by the banner, so only the banner
 * could know an update existed — a user mid-work had to restart the app to
 * re-check. The state is now a module-level observable store both the banner
 * AND the Settings "Bản cập nhật" card subscribe to:
 *
 *  - checkForDesktopUpdate()   manual/auto check → checking → uptodate |
 *                              available(version) | check-error. Settings-local
 *                              phases never surface in the banner.
 *  - startDesktopUpdateInstall() available → starting → downloading → …
 *                              The BANNER stays the install surface (F22 job
 *                              confirm + progress + Retry live there).
 *
 * Guard contract: checks are skipped while an install flows; a second install
 * start while one is in flight is a no-op (F7 double-click guard, now in the
 * store instead of a hook-local ref — shared by every caller).
 */

const IDLE_STATE: DesktopUpdateState = { phase: 'idle', percent: null };

/** Phases where an install/download is in flight — nothing may stomp them. */
const INSTALL_BUSY: DesktopUpdateState['phase'][] = [
  'starting',
  'downloading',
  'installing',
  'restarting',
];

let state: DesktopUpdateState = IDLE_STATE;
const listeners = new Set<() => void>();

function set(next: DesktopUpdateState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getDesktopUpdateState(): DesktopUpdateState {
  return state;
}

export function subscribeDesktopUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam — the store is module-global, suites must start from idle. */
export function resetDesktopUpdateStore(): void {
  state = IDLE_STATE;
}

export async function checkForDesktopUpdate(): Promise<void> {
  if (!isTauri()) return;
  if (state.phase === 'checking' || INSTALL_BUSY.includes(state.phase)) return;
  set({ phase: 'checking', percent: null, lastCheckedAt: state.lastCheckedAt });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (update) {
      set({
        phase: 'available',
        percent: null,
        availableVersion: update.version,
        lastCheckedAt: Date.now(),
      });
    } else {
      set({ phase: 'uptodate', percent: null, lastCheckedAt: Date.now() });
    }
  } catch (err) {
    // The manual check must give feedback where it was clicked (Settings), not
    // pop the global banner — a transient endpoint hiccup is not "an update
    // story" and the periodic auto-check has always swallowed these.
    set({
      phase: 'check-error',
      percent: null,
      message: err instanceof Error ? err.message : String(err),
      lastCheckedAt: Date.now(),
    });
  }
}

export function startDesktopUpdateInstall(): void {
  if (!isTauri()) return;
  // INSTALL_BUSY already includes 'starting' — a second click while the flow
  // runs is a no-op (F7), replacing the old hook-local busyRef.
  if (INSTALL_BUSY.includes(state.phase)) return;
  set({ phase: 'starting', percent: null });
  // Every flow emission lands in the store unfiltered: 'idle' (flow's own
  // re-check found nothing) hides the banner — the P2-6 dead-end fix now
  // lives in this single sink.
  void runDesktopUpdateFlow((next) => set(next));
}
