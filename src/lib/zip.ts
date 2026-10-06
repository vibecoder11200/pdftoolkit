/*
 * Store-only ZIP writer — no compression, no dependencies. Runs in the PDF
 * worker (red-team #10: heavyweight byte work never touches the main thread;
 * the client just transfers the result back under the buffer contract).
 *
 * Deliberately minimal for the pdf-to-img batch download (phase 6):
 * - method 0 (store) — PNG/JPEG payloads are already compressed
 * - version 20, UTF-8 filename flag (0x0800), no ZIP64 — the 200MB total
 *   budget keeps every field inside 32-bit ranges
 * - entry names come from user filenames, so sanitize() is mandatory:
 *   no path separators, no control chars, 255-byte cap, deduped with -N
 *   suffixes before the extension
 */

export const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export class ZipSizeError extends Error {
  constructor(total: number) {
    super(`zip input ${total} bytes exceeds the ${ZIP_MAX_TOTAL_BYTES} byte budget`);
    this.name = 'ZipSizeError';
  }
}

// CRC-32 (IEEE 802.3), table-driven. Check vector: "123456789" -> 0xCBF43926.
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

/*
 * Strips path separators and C0/C1 control characters, caps the UTF-8
 * encoding at 255 bytes, and falls back to "file" when nothing survives.
 * Names arrive one-per-call; collision suffixing lives in zipStore so the
 * whole entry list is deduped in one pass.
 */
export function sanitizeEntryName(raw: string): string {
  const cleaned = raw.replace(/[\\/]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
  const base = cleaned.length > 0 ? cleaned : 'file';
  if (encoder.encode(base).length <= 255) return base;
  let cut = base.length;
  while (cut > 1 && encoder.encode(base.slice(0, cut)).length > 255) cut--;
  return base.slice(0, cut);
}

// Little-endian writers — DataView keeps the layout explicit.
function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}
function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

// DOS date/time (2-second resolution, years since 1980).
function dosDateTime(d: Date): { date: number; time: number } {
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/*
 * Builds local header + data + central directory + EOCD in one buffer.
 * Throws ZipSizeError when the combined payload crosses the app budget —
 * the phase-6 caller uses that to fall back to per-image downloads.
 */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  let total = 0;
  for (const e of entries) {
    total += e.bytes.byteLength;
  }
  if (total > ZIP_MAX_TOTAL_BYTES) throw new ZipSizeError(total);

  const { date, time } = dosDateTime(new Date());
  const cleaned = entries.map((e) => ({ name: sanitizeEntryName(e.name), bytes: e.bytes }));

  // Collision suffixes: "stem-p1.png" twice -> "stem-p1-1.png".
  const seen = new Map<string, number>();
  const names = cleaned.map(({ name }) => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${stem}-${count}${ext}`;
  });

  const localSize = names.reduce(
    (sum, n) => sum + 30 + encoder.encode(n).length,
    0,
  );
  const centralSize = names.reduce(
    (sum, n) => sum + 46 + encoder.encode(n).length,
    0,
  );
  const out = new Uint8Array(22 + localSize + centralSize + total);
  const view = new DataView(out.buffer);
  const text = (offset: number, value: string) => out.set(encoder.encode(value), offset);

  let offset = 0;
  const centralRows: { name: string; crc: number; size: number; offset: number }[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const { bytes } = cleaned[i];
    const name = names[i];
    const nameLen = encoder.encode(name).length;
    const crc = crc32(bytes);
    u32(view, offset, 0x04034b50); // local file header signature
    u16(view, offset + 4, 20); // version needed
    u16(view, offset + 6, 0x0800); // UTF-8 name flag
    u16(view, offset + 8, 0); // method: store
    u16(view, offset + 10, time);
    u16(view, offset + 12, date);
    u32(view, offset + 14, crc);
    u32(view, offset + 18, bytes.byteLength); // compressed
    u32(view, offset + 22, bytes.byteLength); // uncompressed
    u16(view, offset + 26, nameLen);
    u16(view, offset + 28, 0); // extra len
    text(offset + 30, name);
    offset += 30 + nameLen;
    out.set(bytes, offset);
    offset += bytes.byteLength;
    centralRows.push({ name, crc, size: bytes.byteLength, offset: offset - bytes.byteLength - 30 - nameLen });
  }

  const centralStart = offset;
  for (const row of centralRows) {
    const nameLen = encoder.encode(row.name).length;
    u32(view, offset, 0x02014b50); // central directory signature
    u16(view, offset + 4, 20); // version made by
    u16(view, offset + 6, 20); // version needed
    u16(view, offset + 8, 0x0800); // UTF-8 flag
    u16(view, offset + 10, 0); // method: store
    u16(view, offset + 12, time);
    u16(view, offset + 14, date);
    u32(view, offset + 16, row.crc);
    u32(view, offset + 20, row.size);
    u32(view, offset + 24, row.size);
    u16(view, offset + 28, nameLen);
    // extra 30, comment 32, disk 34, internal attrs 36, external attrs 38
    u32(view, offset + 42, row.offset); // local header offset
    text(offset + 46, row.name);
    offset += 46 + nameLen;
  }
  const centralEnd = offset;

  u32(view, offset, 0x06054b50); // EOCD
  u16(view, offset + 4, 0); // disk
  u16(view, offset + 6, 0); // central dir disk
  u16(view, offset + 8, cleaned.length); // entries this disk
  u16(view, offset + 10, cleaned.length); // entries total
  u32(view, offset + 12, centralEnd - centralStart);
  u32(view, offset + 16, centralStart);
  u16(view, offset + 20, 0); // comment len
  return out;
}
