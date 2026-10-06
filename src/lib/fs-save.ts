/*
 * File System Access save-back (plan v0.3.0 phase 4, D5). Chromium-only
 * companion to the plain download: lets the user write the output straight
 * into a location they pick. Never replaces the download button — headless
 * e2e cannot drive the picker, and Firefox/Safari don't expose the API.
 */

export interface SavePickerType {
  description: string;
  accept: Record<string, string[]>;
}

export function canPickFile(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/**
 * Open the save picker, write the blob, close the stream. Returns false only
 * when the user cancelled (AbortError — matched BY NAME, never by message
 * text); every other failure throws so the tool surfaces an error instead of
 * leaving a truncated file the user believes is the real output.
 */
export async function saveFilePicker(
  blob: Blob,
  opts: { fileName: string; types?: SavePickerType[] },
): Promise<boolean> {
  if (!canPickFile()) {
    throw new Error('showSaveFilePicker is not available in this browser');
  }
  const picker = (
    window as unknown as {
      showSaveFilePicker: (opts?: {
        suggestedName?: string;
        types?: SavePickerType[];
      }) => Promise<{ createWritable: () => Promise<{
        write: (data: Blob) => Promise<void>;
        close: () => Promise<void>;
      }> }>;
    }
  ).showSaveFilePicker;
  // Both showing the picker and acquiring the stream can be cancelled by the
  // user (Esc on the dialog, dismissed permission prompt) — AbortError from
  // either is a normal cancel, not an error.
  let handle: Awaited<ReturnType<typeof picker>>;
  try {
    handle = await picker({ suggestedName: opts.fileName, types: opts.types });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return false;
    throw e;
  }
  let writable: Awaited<ReturnType<typeof handle.createWritable>>;
  try {
    writable = await handle.createWritable();
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return false;
    throw e;
  }
  let writeError: unknown;
  try {
    await writable.write(blob);
  } catch (e) {
    writeError = e;
  }
  // close() flushes — a failed flush means a broken file even when write()
  // succeeded, so it must propagate too (write errors win as the root cause).
  try {
    await writable.close();
  } catch (closeError) {
    if (!writeError) throw closeError;
  }
  if (writeError) throw writeError;
  return true;
}
