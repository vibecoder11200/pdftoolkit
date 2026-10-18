/**
 * Image intake gate for the watermark image tab (v0.8.0, red-team finding 3):
 * header-sniffs PNG/JPEG and parses the DECLARED dimensions BEFORE any embed.
 * pdf-lib's PNG path decodes to ~w×h×8 bytes (png.js), so a 60000×60000 IHDR
 * declares a ~14.4GB decode — a worker OOM. Rejection must happen at intake
 * (the UI maps `too-many-pixels` to an i18n error), never at embed time.
 *
 * Pure header parsing — zero pdf-lib imports (this module is imported by both
 * the engine and the tool UI). JPEG EXIF orientation is accepted as-is for
 * v0.8.0 (sniff+reject is the cheapest correct gate; canvas re-encode was
 * deliberately not taken).
 */

/** ~100MP decoded-pixel budget (100e6 × 8 bytes ≈ 800MB peak — far under the
 * worker's real ceiling, and no legitimate watermark image comes close). */
export const IMAGE_MAX_PIXELS = 100_000_000;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPngBytes(head: Uint8Array): boolean {
  if (head.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => head[i] === b);
}

export function isJpegBytes(head: Uint8Array): boolean {
  return head.length >= 2 && head[0] === 0xff && head[1] === 0xd8;
}

export type ImageFormat = 'png' | 'jpg';

/**
 * Declared pixel dimensions from PNG IHDR / JPEG SOFn markers, or null when
 * the headers don't yield them (corrupt/unsupported — the embed step will
 * surface its own error for hostile bytes that pass this gate).
 */
export function declaredImageDimensions(
  bytes: Uint8Array,
): { width: number; height: number; format: ImageFormat } | null {
  if (isPngBytes(bytes)) {
    // IHDR must be the first chunk: 8-byte signature, 4-byte length, 'IHDR'.
    if (bytes.length < 24 || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
      return null;
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), format: 'png' };
  }
  if (isJpegBytes(bytes)) {
    // Walk segment markers until an SOFn (height/width at fixed offsets) or
    // a terminator. Standalone markers carry no length field.
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) return null; // desynced — not a parseable JPEG
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1; // fill bytes
        continue;
      }
      const standalone =
        marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
      if (standalone) {
        i += 2;
        continue;
      }
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (i + 9 > bytes.length) return null;
        const height = (bytes[i + 5] << 8) | bytes[i + 6];
        const width = (bytes[i + 7] << 8) | bytes[i + 8];
        return { width, height, format: 'jpg' };
      }
      const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
      if (segLen < 2) return null;
      i += 2 + segLen;
    }
  }
  return null;
}

export type ImageIntakeVerdict =
  | { ok: true; format: ImageFormat; width: number; height: number }
  | { ok: false; reason: 'unsupported' | 'too-many-pixels' };

/**
 * Intake gate: format sniff + declared-dimension budget. `width`/`height` are
 * 0 when the headers could not be parsed but the format is plausible — that
 * case passes the gate and any real decode failure surfaces at embed time.
 */
export function checkImageIntake(bytes: Uint8Array): ImageIntakeVerdict {
  const dims = declaredImageDimensions(bytes);
  if (!dims) {
    if (isPngBytes(bytes) || isJpegBytes(bytes)) {
      return { ok: true, format: isPngBytes(bytes) ? 'png' : 'jpg', width: 0, height: 0 };
    }
    return { ok: false, reason: 'unsupported' };
  }
  if (dims.width * dims.height > IMAGE_MAX_PIXELS) {
    return { ok: false, reason: 'too-many-pixels' };
  }
  return { ok: true, ...dims };
}
