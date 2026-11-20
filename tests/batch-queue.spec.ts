import { describe, expect, it } from 'vitest';

import {
  BatchQueue,
  CancelledError,
  IllegalTransitionError,
  transition,
  validatePlan,
  type QueueItemState,
  type QueueOperation,
  type OutputArtifact,
} from '../src/lib/batch-queue';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expose } from 'comlink';
import { __setEngineWorkerSpawnForTests } from '../src/engine/client';
import { organizeExport } from '../src/engine/pdf-lib';
import { buildQueueRegistry } from '../src/lib/queue-store';
import { parseOutlines } from '../src/lib/bookmarks';
import { pageCountOf } from './helpers/text-assert';

/*
 * Phase-7 batch queue suite: explicit state machine, cardinality validation
 * BEFORE execution, delivery LEDGER (no duplicate delivery across retry),
 * safe-boundary cancellation/pause, one heavy slot.
 */

const artifact = (id: string, name = id + '.pdf'): OutputArtifact => ({
  artifactId: id,
  filename: name,
  bytes: new Uint8Array([1, 2, 3]),
  mime: 'application/pdf',
});

const op = (
  id: string,
  cardinality: { in: 'one' | 'many'; out: 'one' | 'many' },
  run: QueueOperation['run'] = async () => [artifact(id + '-out')],
  acceptsPdf = true,
): QueueOperation => ({ id, run, cardinality, acceptsPdf });

const file = (name: string) => new File([new Uint8Array([9])], name, { type: 'application/pdf' });

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('transition table (illegal transitions THROW)', () => {
  it('allows the documented legal moves', () => {
    const a = { state: 'queued' as QueueItemState };
    transition(a, 'running');
    transition(a, 'paused');
    transition(a, 'running');
    transition(a, 'succeeded');
    expect(a.state).toBe('succeeded');
    const b = { state: 'failed' as QueueItemState };
    transition(b, 'queued'); // retry recomputes from the source
    expect(b.state).toBe('queued');
  });

  it('throws on illegal moves (queued→succeeded, succeeded→anything, cancelled→anything)', () => {
    expect(() => transition({ state: 'queued' }, 'succeeded')).toThrow(IllegalTransitionError);
    expect(() => transition({ state: 'succeeded' }, 'queued')).toThrow(IllegalTransitionError);
    expect(() => transition({ state: 'cancelled' }, 'running')).toThrow(IllegalTransitionError);
  });
});

describe('validatePlan (BEFORE any execution)', () => {
  const registry = new Map<string, QueueOperation>([
    ['merge', op('merge', { in: 'many', out: 'one' })],
    ['compress', op('compress', { in: 'one', out: 'one' })],
    ['imgtool', op('imgtool', { in: 'one', out: 'one' }, undefined, false)],
  ]);

  it('names the exact step + operation for unknown ids', () => {
    expect(() => validatePlan([{ operationId: 'nope', options: {} }], registry, 1)).toThrow(
      /step 1.*nope/,
    );
    expect(() =>
      validatePlan(
        [
          { operationId: 'merge', options: {} },
          { operationId: 'nope', options: {} },
        ],
        registry,
        2,
      ),
    ).toThrow(/step 2.*nope/);
  });

  it('rejects a one-input op receiving many inputs, naming the step', () => {
    expect(() =>
      validatePlan([{ operationId: 'compress', options: {} }], registry, 3),
    ).toThrow(/step 1.*compress.*ONE/);
  });

  it('many→one feeding one→one is legal (merge then compress)', () => {
    expect(() =>
      validatePlan(
        [
          { operationId: 'merge', options: {} },
          { operationId: 'compress', options: {} },
        ],
        registry,
        3,
      ),
    ).not.toThrow();
  });

  it('rejects a non-PDF op fed a PDF document, empty plans rejected', () => {
    expect(() => validatePlan([{ operationId: 'imgtool', options: {} }], registry, 1)).toThrow(
      /non-PDF/,
    );
    expect(() => validatePlan([], registry, 1)).toThrow(/empty/);
  });
});

describe('BatchQueue execution + delivery ledger', () => {
  it('runs merge→compress and delivers exactly once', async () => {
    const deliveries: string[] = [];
    const q = new BatchQueue({
      registry: new Map([
        ['merge', op('merge', { in: 'many', out: 'one' })],
        ['compress', op('compress', { in: 'one', out: 'one' })],
      ]),
      deliver: async (arts) => {
        for (const a of arts) deliveries.push(a.artifactId);
        return arts.map((a) => ({ artifactId: a.artifactId, status: 'saved' }));
      },
    });
    const item = q.enqueue(
      [
        { operationId: 'merge', options: {} },
        { operationId: 'compress', options: {} },
      ],
      [file('a.pdf'), file('b.pdf')],
    );
    void q.pump();
    await settle();
    await settle();
    expect(item.state).toBe('succeeded');
    expect(deliveries).toEqual(['compress-out']);
    expect(item.deliveredIds.has('compress-out')).toBe(true);
    expect(item.progress).toBe(1);
  });

  it('partial delivery → failed; retry delivers ONLY the undelivered ids', async () => {
    const calls: string[][] = [];
    const q = new BatchQueue({
      registry: new Map([['merge', op('merge', { in: 'many', out: 'one' })]]),
      deliver: async (arts) => {
        calls.push(arts.map((a) => a.artifactId));
        return arts.map((a) => ({
          artifactId: a.artifactId,
          status: calls.length === 1 && a.artifactId !== 'out-1' ? 'failed' : 'saved',
        }));
      },
    });
    const m = op('merge', { in: 'many', out: 'many' }, async () => [
      artifact('out-1'),
      artifact('out-2'),
    ]);
    (q as unknown as { opts: { registry: Map<string, QueueOperation> } }).opts.registry.set(
      'multi',
      m,
    );
    const item = q.enqueue([{ operationId: 'multi', options: {} }], [file('a.pdf')]);
    void q.pump();
    await settle();
    await settle();
    expect(item.state).toBe('failed'); // out-2 not delivered
    expect(item.deliveredIds.has('out-2')).toBe(false);
    await q.resume(item.id);
    await settle();
    await settle();
    expect(item.state).toBe('succeeded');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['out-2']); // out-1 NEVER re-delivered
    expect([...item.deliveredIds].sort()).toEqual(['out-1', 'out-2']);
  });

  it('failed executor marks the item failed with the error message', async () => {
    const boom = op('boom', { in: 'one', out: 'one' }, async () => {
      throw new Error('engine exploded');
    });
    const q = new BatchQueue({
      registry: new Map([['boom', boom]]),
      deliver: async (arts) => arts.map((a) => ({ artifactId: a.artifactId, status: 'saved' })),
    });
    const item = q.enqueue([{ operationId: 'boom', options: {} }], [file('a.pdf')]);
    void q.pump();
    await settle();
    await settle();
    expect(item.state).toBe('failed');
    expect(item.error).toBe('engine exploded');
  });
});

describe('cancellation + pause at safe boundaries', () => {
  it('cancel before pump: queued item cancels without running', () => {
    let ran = false;
    const q = new BatchQueue({
      registry: new Map([
        ['x', op('x', { in: 'one', out: 'one' }, async () => { ran = true; return [artifact('x')]; })],
      ]),
      deliver: async (arts) => arts.map((a) => ({ artifactId: a.artifactId, status: 'saved' })),
    });
    const item = q.enqueue([{ operationId: 'x', options: {} }], [file('a.pdf')]);
    q.requestCancel(item.id);
    expect(item.state).toBe('cancelled');
    void q.pump();
    expect(ran).toBe(false);
  });

  it('cancel mid-run: executor observes shouldStop and the item lands cancelled', async () => {
    const gate = deferred<void>();
    const q = new BatchQueue({
      registry: new Map([
        [
          'slow',
          op('slow', { in: 'one', out: 'one' }, async (_inputs, _options, ctx) => {
            await gate.promise;
            if (ctx.shouldStop()) throw new CancelledError();
            return [artifact('slow')];
          }),
        ],
      ]),
      deliver: async (arts) => arts.map((a) => ({ artifactId: a.artifactId, status: 'saved' })),
    });
    const item = q.enqueue([{ operationId: 'slow', options: {} }], [file('a.pdf')]);
    void q.pump();
    await settle();
    expect(item.state).toBe('running');
    q.requestCancel(item.id); // cooperative: only the flag flips, the state flips when the executor observes it
    expect(item.cancelRequested).toBe(true);
    gate.resolve();
    await settle();
    await settle();
    expect(item.state).toBe('cancelled');
    expect(item.deliveredIds.size).toBe(0);
  });

  it('pause between steps, resume completes (slot kept while paused)', async () => {
    const step1 = deferred<void>();
    const q = new BatchQueue({
      registry: new Map([
        ['one', op('one', { in: 'many', out: 'one' }, async () => {
          await step1.promise;
          return [artifact('one-out')];
        })],
        ['two', op('two', { in: 'one', out: 'one' })],
      ]),
      deliver: async (arts) => arts.map((a) => ({ artifactId: a.artifactId, status: 'saved' })),
    });
    const item = q.enqueue(
      [
        { operationId: 'one', options: {} },
        { operationId: 'two', options: {} },
      ],
      [file('a.pdf'), file('b.pdf')],
    );
    void q.pump();
    await settle();
    q.requestPause(item.id); // honored at the NEXT safe boundary (before step 2)
    step1.resolve();
    await settle();
    await settle();
    expect(item.state).toBe('paused');
    expect(item.stepIndex).toBe(1); // step 1 done, parked before step 2
    q.resume(item.id);
    await settle();
    await settle();
    expect(item.state).toBe('succeeded');
  });
});

describe('one heavy slot', () => {
  it('items run strictly sequentially', async () => {
    const gate = deferred<void>();
    let concurrent = 0;
    let maxConcurrent = 0;
    const mk = () =>
      op('heavy', { in: 'one', out: 'one' }, async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate.promise;
        concurrent -= 1;
        return [artifact('heavy')];
      });
    const q = new BatchQueue({
      registry: new Map([['heavy', mk()]]),
      deliver: async (arts) => arts.map((a) => ({ artifactId: a.artifactId, status: 'saved' })),
    });
    const i1 = q.enqueue([{ operationId: 'heavy', options: {} }], [file('a.pdf')]);
    const i2 = q.enqueue([{ operationId: 'heavy', options: {} }], [file('b.pdf')]);
    void q.pump();
    await settle();
    expect(i1.state).toBe('running');
    expect(i2.state).toBe('queued'); // slot occupied
    gate.resolve();
    await settle();
    void q.pump();
    await settle();
    await settle();
    expect(i2.state).toBe('succeeded');
    expect(maxConcurrent).toBe(1);
  });
});

describe('multi-item scheduling (review fix 2026-11-14)', () => {
  it('starts queued items automatically when the slot frees', async () => {
    const deliver = async (arts: OutputArtifact[]) =>
      arts.map((a) => ({ artifactId: a.artifactId, status: 'saved' }));
    const q = new BatchQueue({
      registry: new Map([['x', op('x', { in: 'one', out: 'one' })]]),
      deliver,
    });
    const a = q.enqueue([{ operationId: 'x', options: {} }], [file('a.pdf')]);
    const b = q.enqueue([{ operationId: 'x', options: {} }], [file('b.pdf')]);
    void q.pump(); // ONE pump call: B must start via the finally re-pump
    await settle();
    await settle();
    await settle();
    expect(a.state).toBe('succeeded');
    expect(b.state).toBe('succeeded');
  });
});

describe('awaitInput checkpoint (parked, review fix 2026-11-14)', () => {
  it('parks the executor; resume() completes the run to succeeded', async () => {
    const gate = deferred<void>();
    const deliver = async (arts: OutputArtifact[]) =>
      arts.map((a) => ({ artifactId: a.artifactId, status: 'saved' }));
    const q = new BatchQueue({
      registry: new Map([
        [
          'cp',
          op('cp', { in: 'one', out: 'one' }, async (_inputs, _options, ctx) => {
            await ctx.awaitInput(); // parks in awaiting-input
            await gate.promise;
            return [artifact('cp')];
          }),
        ],
      ]),
      deliver,
    });
    const item = q.enqueue([{ operationId: 'cp', options: {} }], [file('a.pdf')]);
    void q.pump();
    await settle();
    expect(item.state).toBe('awaiting-input');
    q.resume(item.id);
    await settle();
    expect(item.state).toBe('running'); // un-parked, executor still awaited
    gate.resolve();
    await settle();
    await settle();
    expect(item.state).toBe('succeeded');
    expect(item.progress).toBe(1);
  });

  it('cancel during awaiting-input rejects the parked executor and lands cancelled', async () => {
    const deliver = async (arts: OutputArtifact[]) =>
      arts.map((a) => ({ artifactId: a.artifactId, status: 'saved' }));
    const q = new BatchQueue({
      registry: new Map([
        [
          'cp',
          op('cp', { in: 'one', out: 'one' }, async (_inputs, _options, ctx) => {
            await ctx.awaitInput();
            return [artifact('cp')];
          }),
        ],
      ]),
      deliver,
    });
    const item = q.enqueue([{ operationId: 'cp', options: {} }], [file('a.pdf')]);
    void q.pump();
    await settle();
    expect(item.state).toBe('awaiting-input');
    q.requestCancel(item.id);
    expect(item.state).toBe('cancelled');
    await settle();
    await settle();
    // parked executor un-parks with CancelledError -> catch -> already cancelled
    expect(item.state).toBe('cancelled');
    expect(item.deliveredIds.size).toBe(0);
  });
});


/*
 * v0.13.0 phase-4 adapters over the REAL registry (queue-store): the new
 * ops' cardinality contract, and the organize run through the REAL engine
 * (worker = MessageChannel double serving the REAL organizeExport — the
 * engine-respawn.spec pattern) with real pdf.js outline reads + remap.
 */
describe('phase-4 queue adapters (real registry, real engine)', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const readFixture = (name: string) =>
    new Uint8Array(readFileSync(join(root, 'fixtures', name)));

  it('page-numbers takes ONE input; organize is many→one (validatePlan names the step)', () => {
    const registry = buildQueueRegistry();
    expect(registry.get('page-numbers')!.cardinality).toEqual({ in: 'one', out: 'one' });
    expect(registry.get('organize')!.cardinality).toEqual({ in: 'many', out: 'one' });
    expect(() =>
      validatePlan([{ operationId: 'page-numbers', options: {} }], registry, 2),
    ).toThrow(/step 1.*page-numbers.*ONE/);
    expect(() =>
      validatePlan([{ operationId: 'organize', options: {} }], registry, 3),
    ).not.toThrow();
  });

  it(
    'organize: 3 real files → ONE artifact, outlines carried with offsets',
    { timeout: 30_000 },
    async () => {
      __setEngineWorkerSpawnForTests(() => {
        const api = {
          organizeExport: (
            sources: Uint8Array[],
            pages: Parameters<typeof organizeExport>[1],
            bookmarks: Parameters<typeof organizeExport>[2],
          ) => organizeExport(sources, pages, bookmarks),
        };
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
          start: () => port1.start(),
          terminate: () => {
            port1.close();
            port2.close();
          },
        };
        return w as unknown as Worker;
      });
      try {
        const mk = (bytes: Uint8Array, name: string) =>
          new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
        const bm = readFixture('bookmarks.pdf'); // 3 pages, 2 roots + nested child
        const small = readFixture('fixture-small.pdf'); // 2 pages, no outline
        const registry = buildQueueRegistry();
        const run = registry.get('organize')!.run;
        const arts = await run(
          [mk(bm, 'a.pdf'), mk(small, 'b.pdf'), mk(bm, 'c.pdf')],
          {},
          {
            itemId: 't-organize',
            shouldStop: () => false,
            onProgress: () => {},
            awaitInput: async () => undefined,
          },
        );
        expect(arts).toHaveLength(1);
        expect(arts[0]!.filename).toBe('3-file-tap-hop-giu-dau-trang.pdf');
        expect(await pageCountOf(arts[0]!.bytes)).toBe(8); // 3 + 2 + 3, input order
        const parsed = await parseOutlines(arts[0]!.bytes);
        expect(parsed.roots.map((r) => r.title)).toEqual([
          'Chương 1',
          'Chương 2 - tài liệu',
          'Chương 1',
          'Chương 2 - tài liệu',
        ]);
        expect(parsed.roots[2]!.dest!.page).toBe(6); // source-2 p1 → offset 5 + 1
        expect(parsed.roots[3]!.dest!.page).toBe(7); // p2 → 5 + 2
        expect(parsed.roots[3]!.children[0]!.title).toBe('Mục 1.1');
        expect(parsed.roots[3]!.children[0]!.dest!.page).toBe(8); // p3 → 5 + 3
      } finally {
        __setEngineWorkerSpawnForTests(null);
      }
    },
  );

  it(
    'review regression: ONE unreadable source fails the item — never a truncated succeeded artifact',
    { timeout: 30_000 },
    async () => {
      // Promise.all collapsed wholesale before (review P1): one corrupt
      // source zeroed EVERY count -> each source planned as 1 page while
      // carryOverBookmarks remapped with real counts (offsets disagreeing
      // with the output). allSettled keeps the valid counts; the corrupt
      // source contributes exactly 1 page (same fallback rule as the
      // bookmark carry — plan and offsets can never disagree).
      __setEngineWorkerSpawnForTests(() => {
        const api = {
          organizeExport: (
            sources: Uint8Array[],
            pages: Parameters<typeof organizeExport>[1],
            bookmarks: Parameters<typeof organizeExport>[2],
          ) => organizeExport(sources, pages, bookmarks),
        };
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
          start: () => port1.start(),
          terminate: () => {
            port1.close();
            port2.close();
          },
        };
        return w as unknown as Worker;
      });
      try {
        const mk = (bytes: Uint8Array, name: string) =>
          new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
        const bm = readFixture('bookmarks.pdf'); // 3 pages + outline
        // "%PDF-!" — header present, body unreadable
        const corrupt = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x21]);
        const registry = buildQueueRegistry();
        const run = registry.get('organize')!.run;
        // The honest contract: an unreadable source FAILS THE ITEM — the
        // pre-fix behavior produced a truncated "succeeded" artifact (every
        // source planned as 1 page) with bookmark offsets pointing past the
        // output. Never a silent partial; the error surfaces in the queue.
        await expect(
          run(
            [mk(bm, 'ok.pdf'), mk(corrupt, 'bad.pdf')],
            {},
            {
              itemId: 't-organize-partial',
              shouldStop: () => false,
              onProgress: () => {},
              awaitInput: async () => undefined,
            },
          ),
        ).rejects.toThrow();
      } finally {
        __setEngineWorkerSpawnForTests(null);
      }
    },
  );
});
