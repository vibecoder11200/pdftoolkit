import { afterAll, describe, expect, it } from 'vitest';
import { expose } from 'comlink';
import { PDFDocument } from 'pdf-lib';
import {
  EngineCrashedError,
  __engineWorkerForTests,
  __setEngineWorkerSpawnForTests,
  engine,
} from '../src/engine/client';
import { loadPdf } from '../src/engine/pdf-lib';

/*
 * Engine-client crash resilience (v0.8.1 phase 3E). pdf.worker.ts cannot be
 * spawned under vitest (no module-worker global), so — exactly like
 * tests/ai-worker-client.spec.ts — the comlink Worker seam is injected: each
 * spawn is a MessageChannel-backed double with the REAL comlink expose()/wrap
 * round trip, serving the REAL engine loadPdf (only the worker constructor is
 * a double). Crash injection fires onerror on the live underlying worker.
 */

interface FakeWorkerHandle {
  worker: Worker;
  fireError(): void;
}

function portWorker(api: Record<string, unknown>): FakeWorkerHandle {
  const { port1, port2 } = new MessageChannel();
  expose(api, port2);
  const w = {
    onerror: null as ((e: Event) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage: (data: unknown, transfer?: Transferable[]) =>
      (port1 as { postMessage(d: unknown, t?: Transferable[]): void }).postMessage(data, transfer),
    addEventListener: (type: string, cb: EventListener) =>
      port1.addEventListener(type, cb as EventListener),
    removeEventListener: (type: string, cb: EventListener) =>
      port1.removeEventListener(type, cb as EventListener),
    // comlink's wrap() calls ep.start() before awaiting a reply — a
    // MessagePort only starts delivering after start() (or an onmessage set).
    start: () => port1.start(),
    terminate: () => {
      port1.close();
      port2.close();
    },
  };
  return {
    worker: w as unknown as Worker,
    fireError: () => w.onerror?.(new Event('error')),
  };
}

async function tinyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]);
  return doc.save();
}

describe('engine client crash resilience', () => {
  const spawned: FakeWorkerHandle[] = [];
  __setEngineWorkerSpawnForTests(() => {
    // Spawn 0 hangs every call (the in-flight victim); later spawns serve
    // the REAL engine loadPdf — the respawn must actually work.
    const api =
      spawned.length === 0
        ? { loadPdf: (): Promise<never> => new Promise(() => undefined) }
        : { loadPdf: (bytes: Uint8Array) => loadPdf(bytes) };
    const handle = portWorker(api);
    spawned.push(handle);
    return handle.worker;
  });

  afterAll(() => {
    __setEngineWorkerSpawnForTests(null); // restore the production spawn
  });

  it('an in-flight call rejects with the typed EngineCrashedError (never settles on its own)', async () => {
    const bytes = await tinyPdf();
    const inflight = engine.loadPdf(bytes);
    await new Promise((r) => setTimeout(r, 25)); // let comlink deliver the call
    expect(spawned).toHaveLength(1);
    expect(__engineWorkerForTests()).toBe(spawned[0].worker);
    spawned[0].fireError(); // the worker dies mid-call
    const err = await inflight.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineCrashedError);
    expect((err as Error).name).toBe('EngineCrashedError');
  });

  it('the NEXT engine call succeeds — the worker respawned lazily', async () => {
    const bytes = await tinyPdf();
    const { info } = await engine.loadPdf(bytes);
    expect(info.numPages).toBe(1);
    expect(info.pageInfos[0]).toMatchObject({ pageNumber: 1, width: 200, height: 100 });
    expect(spawned).toHaveLength(2); // respawned through the seam
    expect(__engineWorkerForTests()).toBe(spawned[1].worker);
  });
});
