/*
 * Directory batch pick (`webkitdirectory`). The browser hands us a flat
 * FileList of every file in the tree; we filter by extension, sort by name,
 * and skip 0-byte entries with a count so the caller can report them.
 *
 * Budget is a TOTAL-BYTES cap (500MB per validation D1), not a file count —
 * a count guard breaks down across fixture sizes (red-team #7). Each kept
 * file still flows through the tool's add() → checkPdfFile gate afterwards;
 * the per-file 200MB ceiling lives in file-accept.ts, not here.
 */

export const DIR_PICK_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

export interface DirPickOk {
  ok: true;
  files: File[];
  skippedEmpty: number;
}

export interface DirPickOverBudget {
  ok: false;
  reason: 'budget';
  totalBytes: number;
}

export type DirPickOutcome = DirPickOk | DirPickOverBudget;

export function filterDirEntries(
  files: File[],
  extensions: string[],
): { files: File[]; skippedEmpty: number } {
  const exts = extensions.map((e) => e.toLowerCase());
  const kept: File[] = [];
  let skippedEmpty = 0;
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (!exts.some((ext) => name.endsWith(ext))) continue;
    if (file.size === 0) {
      skippedEmpty += 1;
      continue;
    }
    kept.push(file);
  }
  kept.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
  return { files: kept, skippedEmpty };
}

export function toDirPickOutcome(
  filtered: { files: File[]; skippedEmpty: number },
): DirPickOutcome {
  const total = filtered.files.reduce((sum, f) => sum + f.size, 0);
  if (total > DIR_PICK_MAX_TOTAL_BYTES) {
    return { ok: false, reason: 'budget', totalBytes: total };
  }
  return { ok: true, files: filtered.files, skippedEmpty: filtered.skippedEmpty };
}

/** Opens the native directory picker; resolves empty (not an error) on cancel. */
export async function pickDirectory(extensions: string[]): Promise<DirPickOutcome> {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  // webkitdirectory has no camelCase property; the bare `directory` attr
  // covers older EdgeHTML builds.
  input.setAttribute('webkitdirectory', '');
  input.setAttribute('directory', '');
  input.style.display = 'none';
  document.body.appendChild(input);
  const selection = await new Promise<FileList | null>((resolve) => {
    let settled = false;
    const done = (value: FileList | null) => {
      if (settled) return;
      settled = true;
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      window.removeEventListener('focus', onFocus);
      resolve(value);
    };
    const onChange = () => done(input.files);
    const onCancel = () => done(null);
    // `cancel` is missing on older browsers (iOS Safari < 16.4): the window
    // regains focus when the picker closes either way, so treat a refocus
    // with no selection as cancel. The delay lets a fast `change` win.
    const onFocus = () => {
      setTimeout(() => {
        if (!input.files || input.files.length === 0) done(null);
      }, 300);
    };
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    window.addEventListener('focus', onFocus);
    input.click();
  });
  input.remove();
  if (!selection) return { ok: true, files: [], skippedEmpty: 0 };
  return toDirPickOutcome(filterDirEntries(Array.from(selection), extensions));
}
