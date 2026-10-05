export const MAX_FILE_BYTES = 200 * 1024 * 1024;

export type FileVerdict =
  | { ok: true }
  | { ok: false; reason: 'too-large' | 'not-pdf' | 'heic-refused' };

const HEIC_TYPES = new Set(['image/heic', 'image/heif']);

export function sniffPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  return (
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

export function sniffHeicName(name: string): boolean {
  return /\.(heic|heif)$/i.test(name);
}

export async function checkPdfFile(file: File): Promise<FileVerdict> {
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' };
  if (HEIC_TYPES.has(file.type) || sniffHeicName(file.name)) {
    return { ok: false, reason: 'heic-refused' };
  }
  // Magic bytes are mandatory (phase 5): a renamed non-PDF must not pass on
  // MIME or extension alone. The empty-MIME acceptance from phase 1 only
  // controls what the file picker offers, never what the engine receives.
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!sniffPdfMagic(head)) return { ok: false, reason: 'not-pdf' };
  return { ok: true };
}
