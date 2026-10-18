/**
 * Shared memoized Roboto-Regular loader (v0.8.0). The font is the proven
 * Vietnamese-capable embed (subset: true → kilobytes in the output).
 *
 * The ?inline import MUST stay DYNAMIC: the entry graph reaches this module
 * (suggest.ts → engine/client.ts), and a static ?inline import would inline
 * the ~690KB base64 data URL into the entry chunk. Lazy like
 * ocr-sandwich's loader, with two contract upgrades for the watermark/pagenum
 * engine path: the decoded bytes are memoized, and every call returns a FRESH
 * .slice() — caller-owned, safe to hand across comlink repeatedly (every send
 * copies anyway — buffers.ts — so this is clone hygiene, not a detachment
 * guard).
 */
let cached: Uint8Array | null = null;

export async function robotoBytes(): Promise<Uint8Array> {
  if (!cached) {
    const m = await import('../assets/fonts/Roboto-Regular.ttf?inline');
    const b64 = m.default.slice(m.default.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    cached = bytes;
  }
  return cached.slice();
}
