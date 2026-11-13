import { isTauri } from './platform';
import { deliveryOverall, type DeliveryReport } from './delivery-report';

/*
 * Session-writer types mirror the Rust command payloads (save_writer.rs).
 * The token authorizes writes into the ONE directory whose handle the Rust
 * side opened at begin; write commands take token + basename only, so a
 * non-chosen path is not merely denied — it is structurally unaddressable.
 */
export interface SessionWriteOutcome {
  ok: boolean;
  path?: string;
  error?: string;
}

/*
 * Desktop save flow (user probe finding: WebView2's <a download> drops files
 * into Downloads silently — no chooser, no path). On desktop EVERY save goes
 * through the native Save-As dialog (plugin-dialog) and plugin-fs writes the
 * bytes to the picked path; the dialog plugin adds the picked path to the fs
 * scope at runtime, so no broad fs scope is granted in capabilities.
 * Cancel (null path) is NOT an error — parity with the web picker contract
 * in download.ts.
 */

const DIALOG_FILTERS: Record<string, { name: string; extensions: string[] }> = {
  'application/pdf': { name: 'PDF', extensions: ['pdf'] },
  'application/zip': { name: 'ZIP', extensions: ['zip'] },
  'image/png': { name: 'PNG', extensions: ['png'] },
  'image/jpeg': { name: 'JPG', extensions: ['jpg', 'jpeg'] },
};

export function isDesktopSaveAvailable(): boolean {
  return isTauri();
}

export async function saveBytesDesktop(
  bytes: Uint8Array,
  filename: string,
  mime = 'application/pdf',
): Promise<boolean> {
  const path = await pickSavePath(filename, mime);
  if (!path) return false;
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(path, bytes);
  return true;
}

export type DesktopSaveEntry = { bytes: Uint8Array; filename: string; artifactId?: string };

/**
 * Phase-3 multi-output save: ONE native directory picker
 * (plugin-dialog `open` with directory:true — the real dialog, mockable in
 * desktop e2e), then the Rust session writer. The picked path crosses IPC
 * exactly once, at begin; every write is token + basename + raw bytes
 * (plugin-fs's raw-body invoke pattern), so a non-chosen sibling/home path
 * is structurally unaddressable at write time. Per-entry failures continue
 * the batch; `save_session_end` always runs in finally; a begin failure
 * leaves no session to end. Cancel ⇒ { cancelled, [] }.
 */
export async function saveSessionMulti(
  entries: DesktopSaveEntry[],
  _mime = 'application/pdf',
): Promise<DeliveryReport> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const dir = await open({ directory: true, multiple: false, title: undefined });
  if (!dir || Array.isArray(dir)) return { overall: 'cancelled', entries: [] };
  const { invoke } = await import('@tauri-apps/api/core');
  const { token } = await invoke<{ token: string }>('save_session_begin', { path: dir });
  try {
    const out: SessionWriteOutcome[] = [];
    for (const e of entries) {
      try {
        const o = await invoke<SessionWriteOutcome>('save_session_write', e.bytes, {
          headers: { token, name: encodeURIComponent(e.filename) },
        });
        out.push(o);
      } catch (err) {
        // Continue after per-file write errors (phase-3 step 4).
        out.push({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const reportEntries = out.map((o, i) => ({
      artifactId: entries[i]?.artifactId ?? `a${i}`,
      filename: entries[i]?.filename ?? `out-${i + 1}`,
      status: o.ok ? ('saved' as const) : ('failed' as const),
      path: o.path,
      error: o.error,
    }));
    return { overall: deliveryOverall(reportEntries), entries: reportEntries };
  } finally {
    try {
      await invoke('save_session_end', { token });
    } catch {
      // end is best-effort; Drop on the Rust side closes the handle anyway.
    }
  }
}

async function pickSavePath(
  filename: string,
  mime: string,
): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const known = DIALOG_FILTERS[mime];
  const ext = known?.extensions[0] ?? filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'pdf';
  return save({
    defaultPath: filename,
    filters: [known ?? { name: ext.toUpperCase(), extensions: [ext] }],
  });
}
