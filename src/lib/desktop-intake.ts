import { isTauri } from './platform';
import { DIR_PICK_MAX_TOTAL_BYTES } from './dir-picker';

/*
 * Desktop (Tauri) file intake — the OS counterpart of launch-queue.ts. Every
 * channel (second-instance argv, macOS Opened, window drag-drop, cold-start
 * argv) arrives as ABSOLUTE PATHS: the Rust side grants the asset-protocol
 * scope per delivered file (D13) and emits; this adapter converts each path
 * with convertFileSrc, fetches the bytes same-origin, and feeds the SAME
 * pending-handoff the PWA launch queue uses (zero fork in the consumers).
 *
 * Everything tauri is dynamically imported BEHIND the isTauri() gate — on the
 * web the chunks never load (consumer never calls this outside desktop).
 *
 * Emit-only boundary (R4): paths cross as JSON payload data; nothing here
 * splices them into code, so hostile file names are inert.
 */

type UnlistenFn = () => void;

export interface DesktopIntakeHooks {
  /** Same contract as initLaunchQueue's onFiles. */
  onFiles: (files: File[]) => void;
  /** Window-level drag highlight (over/enter → true, leave/drop → false). */
  onDragHighlight?: (active: boolean) => void;
}

async function pathsToFiles(paths: string[]): Promise<File[]> {
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  const files: File[] = [];
  let total = 0;
  for (const path of paths) {
    try {
      // Same total-bytes budget as folder-pick (dir-picker.ts) — a 500MB
      // window drop must not wedge the session.
      const res = await fetch(convertFileSrc(path));
      if (!res.ok) continue;
      const bytes = await res.arrayBuffer();
      if (total + bytes.byteLength > DIR_PICK_MAX_TOTAL_BYTES) continue;
      total += bytes.byteLength;
      const name = path.replaceAll('\\', '/').split('/').pop() ?? 'file.pdf';
      files.push(new File([bytes], name, { type: 'application/pdf' }));
    } catch {
      /* scope-revoked or vanished between emit and fetch — skip it */
    }
  }
  return files;
}

/**
 * Starts the desktop intake listeners. Resolves to `undefined` on the web
 * (and when the tauri modules fail to load) — callers must treat that as
 * "no desktop intake", never an error.
 */
export async function initDesktopIntake({
  onFiles,
  onDragHighlight,
}: DesktopIntakeHooks): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const { invoke } = await import('@tauri-apps/api/core');
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');

    const unlisteners: UnlistenFn[] = [];

    const deliver = async (paths: unknown) => {
      if (!Array.isArray(paths)) return;
      const files = await pathsToFiles(paths.filter((p): p is string => typeof p === 'string'));
      if (files.length > 0) onFiles(files);
    };

    // Running instance: "Open with" from the OS (single-instance forwarder or
    // macOS Opened both emit here).
    unlisteners.push(await listen<string[]>('desktop://open-files', (e) => void deliver(e.payload)));
    // Window drag-drop (Rust Drop handler emits after granting scope).
    unlisteners.push(await listen<string[]>('desktop://drop-files', (e) => void deliver(e.payload)));

    // Cold start: a file argument was already on argv before any listener
    // could exist — fetch it once at mount.
    void invoke<string[]>('initial_open_files').then((paths) => void deliver(paths));

    // Highlight-only drag surface: the Drop case is delivered by the Rust
    // emit above, so the JS drag event only toggles the visual state.
    if (onDragHighlight) {
      const webview = getCurrentWebview();
      unlisteners.push(
        await webview.onDragDropEvent((event) => {
          if (event.payload.type === 'enter' || event.payload.type === 'over') {
            onDragHighlight(true);
          } else if (event.payload.type === 'leave' || event.payload.type === 'drop') {
            onDragHighlight(false);
          }
        }),
      );
    }

    return () => {
      for (const off of unlisteners) off();
    };
  } catch {
    // Tauri APIs missing (partial shell, tests) — stay silent like the web.
    return undefined;
  }
}
