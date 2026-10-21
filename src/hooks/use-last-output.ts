import { useCallback, useState } from 'react';

/**
 * Done-state retention for the chaining chip (v0.8.0 phase 4). The LAST
 * single-PDF output is kept BY REFERENCE only when ≤ 100MB — above that the
 * tool retains NOTHING (no reference at all: hide-only retention would still
 * pin the bytes and defeat GC — red-team finding 9). The chip holds a
 * reference, never a copy; the File is constructed at click time
 * (output-file.ts). `keep(null, '')` clears on new-run start and reset.
 */
const MAX_RETAINED_BYTES = 100 * 1024 * 1024;

export interface LastOutput {
  bytes: Uint8Array;
  filename: string;
}

export function useLastOutput() {
  const [lastOutput, setLastOutput] = useState<LastOutput | null>(null);
  const keep = useCallback((bytes: Uint8Array | null, filename: string): void => {
    setLastOutput(
      bytes && bytes.byteLength <= MAX_RETAINED_BYTES ? { bytes, filename } : null,
    );
  }, []);
  return { lastOutput, keep };
}
