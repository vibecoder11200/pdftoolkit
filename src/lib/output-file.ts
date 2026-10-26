/**
 * File-from-bytes for the chaining chip (v0.8.0 phase 4). The Blob
 * constructor SNAPSHOTS the bytes at call time (click time) — the chip holds
 * a reference until then, never a copy. Desktop WebView2 is Chromium, where
 * this constructor is core ES. Kept separate from the chip so node vitest
 * can cover the shape + handoff roundtrip without React.
 */
export function outputFile(bytes: Uint8Array, filename: string): File {
  // TS 7 BlobPart strictness: engine bytes are ArrayBufferLike-typed.
  return new File([bytes as BlobPart], filename, { type: 'application/pdf' });
}
