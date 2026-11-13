import { canPickFile, saveFilePicker, type SavePickerType } from './fs-save';
import {
  isDesktopSaveAvailable,
  saveBytesDesktop,
  saveSessionMulti,
} from './desktop-save';
import {
  deliveryOverall,
  type DeliveryEntry,
  type DeliveryReport,
} from './delivery-report';
import { resolveBatchNames } from './delivery-names';

function toBlob(bytes: Uint8Array, mime: string): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime = 'application/pdf'): void {
  const url = URL.createObjectURL(toBlob(bytes, mime));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

/**
 * File System Access companion (Chromium only — callers gate the button with
 * canSaveElsewhere()). Returns false when the user cancelled the picker;
 * real failures propagate. Cancel is NOT an error.
 */
export async function downloadBytesWithPicker(
  bytes: Uint8Array,
  filename: string,
  mime = 'application/pdf',
): Promise<boolean> {
  return saveFilePicker(toBlob(bytes, mime), {
    fileName: filename,
    types: pickerTypesFor(mime, filename),
  });
}

export function canSaveElsewhere(): boolean {
  // Desktop saves through the native dialog unconditionally (desktop-save);
  // the FSA companion toggle is a web/Chromium affordance only.
  return !isDesktopSaveAvailable() && canPickFile();
}

export type DownloadDest = 'download' | 'pick';

/**
 * One call site per tool for "process → deliver": plain download by default,
 * File System Access picker when the user chose "Chọn nơi lưu". On desktop
 * the dest choice is moot — every save opens the native Save-As dialog
 * (WebView2's silent <a download> gives no chooser and no visible path).
 * Resolves false only for a picker cancel (not an error — callers drop the
 * done progress instead of claiming success).
 */
export async function deliverBytes(
  bytes: Uint8Array,
  filename: string,
  dest: DownloadDest,
  mime = 'application/pdf',
): Promise<boolean> {
  if (isDesktopSaveAvailable()) return saveBytesDesktop(bytes, filename, mime);
  if (dest === 'pick') return downloadBytesWithPicker(bytes, filename, mime);
  downloadBytes(bytes, filename, mime);
  return true;
}

export type DeliverEntry = { bytes: Uint8Array; filename: string; artifactId?: string };

/**
 * Multi-output variant (split parts, per-page images): desktop = ONE native
 * directory picker + the Rust session writer (atomic no-clobber confined
 * writes, per-entry results); web = plain downloads with the historical
 * 150ms gap (multi-download popup allowance). Returns the typed phase-3
 * report — a boolean could hide partial delivery, so nothing here collapses
 * per-entry outcomes.
 *
 * Retry identity: pass the same artifactId on a re-call. Only failed
 * entries are re-sent by the caller (the success ledger is the consumer's
 * report state), so delivered artifacts are never re-delivered.
 */
export async function deliverBytesMulti(
  entries: DeliverEntry[],
  mime = 'application/pdf',
): Promise<DeliveryReport> {
  if (entries.length === 0) return { overall: 'cancelled', entries: [] };
  const names = resolveBatchNames(entries.map((e) => e.filename));
  // results stays index-aligned with `entries`; skipped slots recorded now.
  const results: (DeliveryEntry | undefined)[] = new Array(entries.length);
  const writable: { index: number; entry: DeliverEntry; final: string }[] = [];
  names.forEach((res, i) => {
    const entry = entries[i]!;
    if (!res.ok) {
      results[i] = {
        artifactId: entry.artifactId ?? `a${i}`,
        filename: entry.filename,
        status: 'skipped',
        error: res.error,
      };
      return;
    }
    writable.push({ index: i, entry, final: res.final });
  });
  if (writable.length === 0) {
    return {
      overall: 'failed',
      entries: results.filter((e): e is DeliveryEntry => e !== undefined),
    };
  }

  if (isDesktopSaveAvailable()) {
    try {
      const report = await saveSessionMulti(
        writable.map((w) => ({ bytes: w.entry.bytes, filename: w.final, artifactId: w.entry.artifactId })),
        mime,
      );
      if (report.overall === 'cancelled') return report; // zero writes, nothing attempted
      report.entries.forEach((e, j) => {
        const w = writable[j];
        if (w) results[w.index] = e;
      });
    } catch (e) {
      // IPC-level failure (begin or the whole write call): every writable
      // entry failed; skipped slots keep their own status.
      const msg = e instanceof Error ? e.message : String(e);
      writable.forEach((w) => {
        results[w.index] = {
          artifactId: w.entry.artifactId ?? `a${w.index}`,
          filename: w.final,
          status: 'failed',
          error: msg,
        };
      });
    }
    return {
      overall: deliveryOverall(results.filter((e): e is DeliveryEntry => e !== undefined)),
      entries: results.filter((e): e is DeliveryEntry => e !== undefined),
    };
  }

  // Web path: dispatch in original order (skipped slots were never dispatched).
  for (const w of writable) {
    downloadBytes(w.entry.bytes, w.final, mime);
    results[w.index] = {
      artifactId: w.entry.artifactId ?? `a${w.index}`,
      filename: w.final,
      status: 'dispatched',
    };
    await new Promise((r) => setTimeout(r, 150));
  }
  const merged = results.filter((e): e is DeliveryEntry => e !== undefined);
  return { overall: deliveryOverall(merged), entries: merged };
}

const PICKER_TYPES: Record<string, SavePickerType> = {
  'application/pdf': { description: 'PDF', accept: { 'application/pdf': ['.pdf'] } },
  'application/zip': { description: 'ZIP', accept: { 'application/zip': ['.zip'] } },
  'image/png': { description: 'PNG', accept: { 'image/png': ['.png'] } },
  'image/jpeg': { description: 'JPG', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
};

function pickerTypesFor(mime: string, filename: string): SavePickerType[] | undefined {
  const known = PICKER_TYPES[mime];
  if (known) return [known];
  const ext = filename.match(/\.[a-z0-9]+$/i)?.[0];
  if (!ext) return undefined;
  return [{ description: ext.slice(1).toUpperCase(), accept: { [mime || 'application/octet-stream']: [ext] } }];
}

export function revokeObjectUrl(url: string | null | undefined): void {
  if (url) URL.revokeObjectURL(url);
}
