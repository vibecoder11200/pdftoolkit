import { useSyncExternalStore } from 'react';

import { deliverBytesMulti } from './download';
import { beginJob, endJob } from './jobs';
import {
  BatchQueue,
  CancelledError,
  type QueueItem,
  type QueueItemState,
  type QueueOperation,
} from './batch-queue';
import { engine } from '../engine/client';

/*
 * Phase-7 queue UI wiring: singleton BatchQueue with REAL merge/compress
 * adapters (engine worker), delivery through the phase-3 contract
 * (deliverBytesMulti → typed report → ledger), and the phase-3 job
 * lifecycle: the queue holds an active job while ANY work can resume
 * (queued/running/awaiting-input/paused/failed) so the updater/restart
 * confirmation accurately includes queue work. Extending the registry to
 * further tool executors (OCR arbitration, page numbers …) is recorded
 * follow-up in the phase report.
 */

/** Extending this registry is follow-up work (see phase report). */
export function buildQueueRegistry(): Map<string, QueueOperation> {
  const map = new Map<string, QueueOperation>();
  map.set('merge', {
    id: 'merge',
    cardinality: { in: 'many', out: 'one' },
    acceptsPdf: true,
    run: async (inputs, _options, ctx) => {
      const parts: Uint8Array[] = [];
      for (const f of inputs) {
        if (ctx.shouldStop()) throw new CancelledError();
        parts.push(new Uint8Array(await f.arrayBuffer()));
      }
      const out = await engine.mergePdfs(parts);
      ctx.onProgress(0.9);
      return [
        {
          // stable per item+step: retry re-delivers exactly this identity
          artifactId: ctx.itemId + ':merge:0',
          filename: 'gop-tai-lieu.pdf',
          bytes: out,
          mime: 'application/pdf',
        },
      ];
    },
  });
  // Phase-8: diagnostics/report vs repair adapters (plan: register both in
  // operations/queue). Report is TERMINAL (json out, not PDF).
  map.set('diagnose', {
    id: 'diagnose',
    cardinality: { in: 'one', out: 'one' },
    acceptsPdf: true,
    outKind: 'json' as const,
    run: async (inputs, _options, ctx) => {
      const f = inputs[0];
      if (!f) throw new Error('diagnose: missing input');
      if (ctx.shouldStop()) throw new CancelledError();
      const bytes = new Uint8Array(await f.arrayBuffer());
      const { runDiagnostics } = await import('./pdf-diagnostics');
      const report = await runDiagnostics(bytes);
      return [
        {
          artifactId: ctx.itemId + ':diagnose:0',
          filename: f.name.replace(/\.pdf$/i, '') + '-chan-doan.json',
          bytes: new TextEncoder().encode(JSON.stringify(report, null, 2)),
          mime: 'application/json',
        },
      ];
    },
  });
  map.set('repair', {
    id: 'repair',
    cardinality: { in: 'one', out: 'one' },
    acceptsPdf: true,
    run: async (inputs, _options, ctx) => {
      const f = inputs[0];
      if (!f) throw new Error('repair: missing input');
      if (ctx.shouldStop()) throw new CancelledError();
      const bytes = new Uint8Array(await f.arrayBuffer());
      const { runRepair } = await import('./pdf-repair');
      const out = await runRepair(bytes, f.name);
      return [
        {
          artifactId: ctx.itemId + ':repair:0',
          filename: out.filename,
          bytes: out.bytes,
          mime: 'application/pdf',
        },
      ];
    },
  });
  map.set('compress', {
    id: 'compress',
    cardinality: { in: 'one', out: 'one' },
    acceptsPdf: true,
    run: async (inputs, _options, ctx) => {
      const f = inputs[0];
      if (!f) throw new Error('compress: missing input');
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (ctx.shouldStop()) throw new CancelledError();
      const out = await engine.compressVectorPack(bytes);
      ctx.onProgress(0.9);
      const base = f.name.replace(/\.pdf$/i, '');
      return [
        {
          artifactId: ctx.itemId + ':compress:0',
          filename: base + '-nen.pdf',
          bytes: out,
          mime: 'application/pdf',
        },
      ];
    },
  });
  return map;
}

/** Phase-3 delivery contract: typed report → per-entry ledger statuses. */
async function deliverViaContract(
  arts: { artifactId: string; filename: string; bytes: Uint8Array; mime: string }[],
): Promise<{ artifactId: string; status: string }[]> {
  const report = await deliverBytesMulti(
    arts.map((a) => ({ bytes: a.bytes, filename: a.filename, artifactId: a.artifactId })),
  );
  return report.entries.map((e) => ({ artifactId: e.artifactId, status: e.status }));
}

const RESUMABLE: QueueItemState[] = ['queued', 'running', 'awaiting-input', 'paused', 'failed'];

class QueueStore {
  readonly queue: BatchQueue;
  private listeners = new Set<() => void>();
  private version = 0;
  private jobOpen = false;

  constructor() {
    this.queue = new BatchQueue({
      registry: buildQueueRegistry(),
      deliver: deliverViaContract,
    });
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = (): number => this.version;

  private bump(): void {
    this.version += 1;
    for (const l of this.listeners) l();
    this.syncJob();
  }

  /** beginJob while work can resume; endJob when everything is terminal. */
  private syncJob(): void {
    const resumable = this.queue.items.some((i) => RESUMABLE.includes(i.state));
    if (resumable && !this.jobOpen) {
      beginJob('queue');
      this.jobOpen = true;
    } else if (!resumable && this.jobOpen) {
      endJob('queue');
      this.jobOpen = false;
    }
  }

  enqueue(operationId: 'merge' | 'compress' | 'diagnose' | 'repair', inputs: File[]): QueueItem {
    const item = this.queue.enqueue([{ operationId, options: {} }], inputs);
    void this.queue.pump();
    this.bump();
    return item;
  }

  pause(id: string): void {
    this.queue.requestPause(id);
    this.bump();
  }

  resume(id: string): void {
    this.queue.resume(id);
    this.bump();
  }

  cancel(id: string): void {
    this.queue.requestCancel(id);
    this.bump();
  }

  clearFinished(): void {
    const done = this.queue.items.filter(
      (i) => i.state === 'succeeded' || i.state === 'cancelled',
    );
    for (const d of done) this.queue.items.splice(this.queue.items.indexOf(d), 1);
    if (done.length > 0) this.bump();
  }
}

export const queueStore = new QueueStore();

/**
 * Snapshot hook: items + a revision counter. Queue state flips inside the
 * runner without React knowledge, so the panel polls while ANY item is
 * non-terminal (documented in the phase report — a transition-hook
 * refactor is follow-up, this keeps the runner React-free).
 */
export function useQueueItems(): { items: QueueItem[]; revision: number } {
  const revision = useSyncExternalStore(queueStore.subscribe, queueStore.getSnapshot);
  return { items: queueStore.queue.items, revision };
}
