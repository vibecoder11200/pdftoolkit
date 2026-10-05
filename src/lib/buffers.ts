/**
 * Single-owner buffer contract (spike S5).
 *
 * The Worker keeps the single owned Uint8Array. Each transfer call uses
 * exactly ONE mode: copy XOR transfer. Transferables are only used for
 * payloads above TRANSFER_THRESHOLD to avoid needless neutering.
 */
export const TRANSFER_THRESHOLD = 10 * 1024 * 1024;

export type TransferMode = 'copy' | 'transfer';

export interface OwnedBuffer {
  bytes: Uint8Array;
  mode: TransferMode;
  transfer: ArrayBuffer[];
}

export function ownForWorker(
  source: Uint8Array,
  opts: { mode: TransferMode; byteLength?: number },
): OwnedBuffer {
  if (opts.byteLength !== undefined && opts.byteLength !== source.byteLength) {
    throw new Error(
      `buffers: byteLength mismatch (declared ${opts.byteLength}, actual ${source.byteLength})`,
    );
  }
  if (opts.mode === 'copy') {
    const bytes = source.slice();
    if ((source.buffer as { detached?: boolean }).detached)
      throw new Error('buffers: source detached after copy');
    return { bytes, mode: 'copy', transfer: [] };
  }
  const bytes = new Uint8Array(source.buffer.slice(0));
  return { bytes, mode: 'transfer', transfer: [bytes.buffer] };
}

export function shouldTransfer(byteLength: number): boolean {
  return byteLength > TRANSFER_THRESHOLD;
}

export function assertNotDetached(bytes: Uint8Array, what: string): void {
  if ((bytes.buffer as { detached?: boolean }).detached)
    throw new Error(`buffers: ${what} is detached`);
}
