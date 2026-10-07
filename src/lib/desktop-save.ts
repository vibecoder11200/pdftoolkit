import { isTauri } from './platform';

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

export type DesktopSaveEntry = { bytes: Uint8Array; filename: string };

/**
 * Multi-output save (split parts, per-page images): ONE dialog for the first
 * file; siblings are written next to it with their own names (a dialog per
 * part is hostile). Sibling writes rely on the fs scope granted in
 * capabilities ($HOME/**); a pick outside the home dir may therefore fail
 * on the siblings — the error propagates to the tool's error banner.
 */
export async function saveBytesDesktopMulti(
  entries: DesktopSaveEntry[],
  mime = 'application/pdf',
): Promise<boolean> {
  const first = entries[0];
  const dir = await pickSavePath(first.filename, mime);
  if (!dir) return false;
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')) + 1;
  const folder = dir.slice(0, cut);
  await writeFile(dir, first.bytes);
  for (const entry of entries.slice(1)) {
    await writeFile(`${folder}${entry.filename}`, entry.bytes);
  }
  return true;
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
