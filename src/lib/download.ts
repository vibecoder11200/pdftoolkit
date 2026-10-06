import { saveFilePicker, type SavePickerType } from './fs-save';

export function downloadBytes(bytes: Uint8Array, filename: string, mime = 'application/pdf'): void {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
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
  return saveFilePicker(
    new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }),
    { fileName: filename, types: pickerTypesFor(mime, filename) },
  );
}

export function canSaveElsewhere(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

export type DownloadDest = 'download' | 'pick';

/**
 * One call site per tool for "process → deliver": plain download by default,
 * File System Access picker when the user chose "Chọn nơi lưu". Resolves
 * false only for a picker cancel (not an error — callers drop the done
 * progress instead of claiming success).
 */
export async function deliverBytes(
  bytes: Uint8Array,
  filename: string,
  dest: DownloadDest,
  mime = 'application/pdf',
): Promise<boolean> {
  if (dest === 'pick') return downloadBytesWithPicker(bytes, filename, mime);
  downloadBytes(bytes, filename, mime);
  return true;
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
