import { wrap, transfer } from 'comlink';
import type { Remote } from 'comlink';
import type { WorkerApi } from '../workers/pdf.worker';
import { ownForWorker, shouldTransfer } from '../lib/buffers';
import { robotoBytes } from '../lib/roboto';

/**
 * The engine worker died mid-call (v0.8.1 phase 3). Comlink promises to a
 * dead worker never settle, so the client rejects them with THIS class —
 * defined client-side, name preserved across whatever boundary rethrows it.
 * The worker respawns LAZILY on the next call; the failed op is never
 * auto-retried (D4: an op that already delivered must never silently re-run).
 */
export class EngineCrashedError extends Error {
  constructor(cause?: unknown) {
    super('The PDF engine worker crashed — it will restart on the next operation.', { cause });
    this.name = 'EngineCrashedError';
  }
}

interface PendingCall {
  reject: (err: unknown) => void;
}

let remote: Remote<WorkerApi> | null = null;
let workerRef: Worker | null = null;
/** Test seam (tests/engine-respawn.spec.ts): node/jsdom cannot fetch module
 * workers, so the crash-injection spec injects a MessagePort-backed Worker
 * double wired to the real engine functions via comlink expose(). */
let testSpawn: (() => Worker) | null = null;
const pendingCalls = new Set<PendingCall>();

function crash(event?: Event): void {
  // Suppress the unhandled-error console noise (does not stop cleanup).
  event?.preventDefault?.();
  const doomed = [...pendingCalls];
  pendingCalls.clear();
  for (const p of doomed) p.reject(new EngineCrashedError());
  try {
    workerRef?.terminate();
  } catch {
    /* already gone */
  }
  workerRef = null;
  // LAZY respawn: null the singleton — the next getWorker() spawns fresh.
  remote = null;
}

export function getWorker(): Remote<WorkerApi> {
  if (!remote) {
    // The new URL() literal must stay DIRECTLY inside new Worker for vite to
    // bundle + fingerprint the worker chunk (same constraint as
    // ai-worker-client.ts).
    const worker =
      testSpawn?.() ??
      new Worker(new URL('../workers/pdf.worker.ts', import.meta.url), {
        type: 'module',
      });
    worker.onerror = (e) => crash(e);
    worker.onmessageerror = () => crash();
    workerRef = worker;
    remote = wrap<WorkerApi>(worker);
  }
  return remote;
}

/**
 * Registers a rejector so a crashed worker cannot strand the promise: every
 * engine call runs through this wrapper (the crash handler rejects whatever
 * is still pending). NO auto-retry — the caller decides via the Retry
 * affordance mapped in the tool layer.
 */
function call<T>(op: (r: Remote<WorkerApi>) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const entry: PendingCall = { reject };
    pendingCalls.add(entry);
    op(getWorker())
      .then(resolve, reject)
      .finally(() => pendingCalls.delete(entry));
  });
}

/** Test-only: replace the worker spawn (MessagePort-backed double), dropping
 * any live instance first. `null` restores the production spawn. */
export function __setEngineWorkerSpawnForTests(spawn: (() => Worker) | null): void {
  try {
    workerRef?.terminate();
  } catch {
    /* already gone */
  }
  workerRef = null;
  remote = null;
  testSpawn = spawn;
}

/** Test-only: the live underlying worker (for crash injection). */
export function __engineWorkerForTests(): Worker | null {
  return workerRef;
}

function owned(bytes: Uint8Array): Uint8Array | Transferable {
  const mode = shouldTransfer(bytes.byteLength) ? 'transfer' : 'copy';
  const ownedBuf = ownForWorker(bytes, { mode, byteLength: bytes.byteLength });
  return mode === 'transfer' ? transfer(ownedBuf.bytes, ownedBuf.transfer) : ownedBuf.bytes;
}

export const engine = {
  loadPdf: (bytes: Uint8Array) => call((r) => r.loadPdf(owned(bytes) as Uint8Array)),
  mergePdfs: (parts: Uint8Array[]) =>
    call((r) => r.mergePdfs(parts.map((p) => owned(p) as Uint8Array))),
  mergeSelected: (parts: Uint8Array[], picks: number[][]) =>
    call((r) =>
      r.mergeSelected(
        parts.map((p) => owned(p) as Uint8Array),
        picks,
      ),
    ),
  removePages: (bytes: Uint8Array, pages: number[]) =>
    call((r) => r.removePages(owned(bytes) as Uint8Array, pages)),
  reorderPages: (bytes: Uint8Array, order: number[]) =>
    call((r) => r.reorderPages(owned(bytes) as Uint8Array, order)),
  rotatePages: (bytes: Uint8Array, targets: number[], degrees: 90 | 180 | 270) =>
    call((r) => r.rotatePages(owned(bytes) as Uint8Array, targets, degrees)),
  splitRanges: (bytes: Uint8Array, ranges: number[][]) =>
    call((r) => r.splitRanges(owned(bytes) as Uint8Array, ranges)),
  extractPages: (bytes: Uint8Array, targets: number[]) =>
    call((r) => r.extractPages(owned(bytes) as Uint8Array, targets)),
  compressVectorPack: (bytes: Uint8Array) =>
    call((r) => r.compressVectorPack(owned(bytes) as Uint8Array)),
  linearizePdf: (bytes: Uint8Array) => call((r) => r.linearizePdf(owned(bytes) as Uint8Array)),
  encryptPdf: (bytes: Uint8Array, user: string, owner: string, bits?: 128 | 256) =>
    call((r) => r.encryptPdf(owned(bytes) as Uint8Array, user, owner, bits)),
  decryptPdf: (bytes: Uint8Array, password: string) =>
    call((r) => r.decryptPdf(owned(bytes) as Uint8Array, password)),
  qpdfCheck: (bytes: Uint8Array) => call((r) => r.qpdfCheck(owned(bytes) as Uint8Array)),
  zipStore: (entries: { name: string; bytes: Uint8Array }[]) =>
    call((r) =>
      r.zipStore(entries.map((e) => ({ name: e.name, bytes: owned(e.bytes) as Uint8Array }))),
    ),
  markdownToDocx: (pages: import('../lib/markdown-docx').DocxPages) =>
    call((r) => r.markdownToDocx(pages)),
  inspectCertificateKey: (p12: Uint8Array, password: string) =>
    call((r) => r.inspectCertificateKey(owned(p12) as Uint8Array, password)),
  signWithCertificate: (pdfBytes: Uint8Array, p12: Uint8Array, password: string) =>
    call((r) =>
      r.signWithCertificate(
        owned(pdfBytes) as Uint8Array,
        owned(p12) as Uint8Array,
        password,
      ),
    ),
  // Watermark/page-numbers (v0.8.0): the font (and image bytes, when present)
  // are CALLER-OWNED — sliced per call before the send (every send copies
  // across comlink anyway; buffers.ts). fontTtf omitted → the shared Roboto.
  stampWatermark: async (
    bytes: Uint8Array,
    opts: import('../engine/pdf-lib').StampWatermarkOptions,
    fontTtf?: Uint8Array,
  ) => {
    const font = (fontTtf ?? (await robotoBytes())).slice();
    return call((r) =>
      r.stampWatermark(owned(bytes) as Uint8Array, opts, owned(font) as Uint8Array),
    );
  },
  // Annotate (v0.9.0 phase 4): same caller-owned font pattern as the
  // watermark/page-numbers ops — robotoBytes resolved client-side.
  stampAnnotations: async (
    bytes: Uint8Array,
    opts: import('../engine/pdf-lib').StampAnnotationsOptions,
    fontTtf?: Uint8Array,
  ) => {
    const font = (fontTtf ?? (await robotoBytes())).slice();
    return call((r) =>
      r.stampAnnotations(owned(bytes) as Uint8Array, opts, owned(font) as Uint8Array),
    );
  },
  applyPageNumbers: async (
    bytes: Uint8Array,
    opts: import('../engine/pdf-lib').PageNumbersOptions,
    fontTtf?: Uint8Array,
  ) => {
    const font = (fontTtf ?? (await robotoBytes())).slice();
    return call((r) =>
      r.applyPageNumbers(owned(bytes) as Uint8Array, opts, owned(font) as Uint8Array),
    );
  },
  // Watermark removal (v0.8.1): reverseOwn first (tag is truth), heuristic
  // fallback for foreign files — the tool layer decides the order.
  removeWatermark: (
    bytes: Uint8Array,
    opts: import('../engine/pdf-lib').RemoveWatermarkOptions,
  ) => call((r) => r.removeWatermark(owned(bytes) as Uint8Array, opts)),
  reverseOwnWatermark: (
    bytes: Uint8Array,
    opts?: import('../engine/pdf-lib').ReverseOwnWatermarkOptions,
  ) => call((r) => r.reverseOwnWatermark(owned(bytes) as Uint8Array, opts)),
  // Redact (v0.9.0 phase 2): census is read-only; finalize is THE deliver-
  // capable op. qpdfRewrite / qpdfCanonicalUncompress stay INTERNAL to the
  // finalize tail — never exposed on this surface (invariant 2).
  redactCensus: (bytes: Uint8Array) => call((r) => r.redactCensus(owned(bytes) as Uint8Array)),
  redactFinalize: (
    bytes: Uint8Array,
    spec: import('../engine/pdf-lib').RedactFinalizeSpec,
  ) =>
    call((r) =>
      r.redactFinalize(
        owned(bytes) as Uint8Array,
        {
          ...spec,
          raster: spec.raster?.map((rr) => ({ page: rr.page, jpeg: owned(rr.jpeg) as Uint8Array })),
        },
      ),
    ),
};
