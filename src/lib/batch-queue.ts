/*
 * Phase-7 batch queue (plan 261112-0955 + RT amendments): explicit state
 * machine, one heavy-executor slot, delivery LEDGER separate from state,
 * cardinality validation BEFORE execution, safe-boundary cancellation,
 * artifact leases honored.
 *
 * The runner takes INJECTED step executors (node-testable); the registry
 * currently wires real adapters for merge (many->one) and compress
 * (one->one) — extending per-tool adapters is follow-up work recorded in
 * the phase report (honest scoping).
 */

import { artifactRegistry } from './runtime-artifacts';

export type QueueItemState =
  | 'queued'
  | 'running'
  | 'awaiting-input'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** Explicit transition table — illegal transitions THROW (state-machine
 * tests pin them). */
const TRANSITIONS: Record<QueueItemState, QueueItemState[]> = {
  queued: ['running', 'cancelled'],
  running: ['awaiting-input', 'paused', 'succeeded', 'failed', 'cancelled'],
  'awaiting-input': ['running', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  succeeded: [],
  failed: ['queued'],
  cancelled: [],
};

export class IllegalTransitionError extends Error {
  constructor(readonly from: QueueItemState, readonly to: QueueItemState) {
    super('illegal queue transition ' + from + ' -> ' + to);
    this.name = 'IllegalTransitionError';
  }
}

export function transition(item: { state: QueueItemState }, to: QueueItemState): void {
  if (!TRANSITIONS[item.state].includes(to)) {
    throw new IllegalTransitionError(item.state, to);
  }
  item.state = to;
}

// ---------------------------------------------------------------------------
// Cardinality + operation descriptors
// ---------------------------------------------------------------------------

export type Cardinality = { in: 'one' | 'many'; out: 'one' | 'many' };

export interface QueueOperation {
  /** Tool slug. */
  id: string;
  /** Executor signature: returns artifact descriptors (bytes + name + mime). */
  run: (inputs: File[], options: Record<string, unknown>, ctx: RunContext) => Promise<OutputArtifact[]>;
  cardinality: Cardinality;
  /** PDF intake only (terminal DOCX/CSV/XLSX cannot feed these). */
  acceptsPdf: boolean;
  /** Terminal (non-PDF) output kind, when not PDF. */
  outKind?: 'pdf' | 'docx' | 'csv' | 'xlsx' | 'json';
}

export interface OutputArtifact {
  filename: string;
  bytes: Uint8Array;
  mime: string;
  /** Stable id feeding the delivery ledger (no duplicate deliveries). */
  artifactId: string;
}

export interface RunContext {
  /** Step token for leases. */
  itemId: string;
  /** Cooperative cancel flag — polled between steps/pages. */
  shouldStop: () => boolean;
  /** Progress 0..1 within the item (never 1 before delivery). */
  onProgress: (fraction: number) => void;
  /** Interactive checkpoint: runner parks the item. */
  awaitInput: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Queue item + runner
// ---------------------------------------------------------------------------

export interface QueueItem {
  id: string;
  /** Preset-like chain descriptor: ordered operation ids + options. */
  plan: { operationId: string; options: Record<string, unknown> }[];
  inputs: File[];
  state: QueueItemState;
  /** Step cursor for resume-by-stepId semantics. */
  stepIndex: number;
  /** Interim artifacts produced so far (leased, released after dependents). */
  artifacts: OutputArtifact[];
  progress: number;
  /** Separate delivery LEDGER — delivered artifactIds never re-deliver. */
  deliveredIds: Set<string>;
  error?: string;
  /** Internal: resolvers for a parked awaitInput checkpoint. */
  parkResolve?: () => void;
  parkReject?: (e: unknown) => void;
  /** Pause requested: honored at the next safe boundary. */
  pauseRequested?: boolean;
  cancelRequested?: boolean;
}

let itemCounter = 0;
const nextItemId = () => {
  itemCounter += 1;
  return `q-${itemCounter}-${Date.now().toString(36)}`;
};

export class QueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueValidationError';
  }
}

/** Validate BEFORE any execution: exact incompatible step identified. */
export function validatePlan(
  plan: QueueItem['plan'],
  registry: Map<string, QueueOperation>,
  inputCount: number,
): void {
  if (plan.length === 0) throw new QueueValidationError('empty plan');
  let kind: 'pdf' | 'other' = 'pdf';
  let count: 'one' | 'many' = inputCount > 1 ? 'many' : 'one';
  for (const [i, step] of plan.entries()) {
    const op = registry.get(step.operationId);
    if (!op) throw new QueueValidationError(`step ${i + 1}: unknown operation "${step.operationId}"`);
    if (op.acceptsPdf === false && kind === 'pdf') {
      throw new QueueValidationError(
        `step ${i + 1} ("${step.operationId}") needs non-PDF input but receives ${kind}`,
      );
    }
    if (op.cardinality.in === 'one' && count === 'many') {
      throw new QueueValidationError(
        `step ${i + 1} ("${step.operationId}") takes ONE input but receives many`,
      );
    }
    kind = op.outKind && op.outKind !== 'pdf' ? 'other' : 'pdf';
    count = op.cardinality.out;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface QueueRunnerOptions {
  registry: Map<string, QueueOperation>;
  /** Delivery fn (phase-3 contract): returns per-entry status. */
  deliver: (artifacts: OutputArtifact[]) => Promise<{ artifactId: string; status: string }[]>;
  /** Simultaneous heavy executions — default 1 (plan: one heavy slot). */
  heavySlots?: number;
}

/** Handoff shape the NEXT step consumes as its input File (prior artifact). */
const stepInput = (a: OutputArtifact) => ({ bytes: a.bytes, name: a.filename, mime: a.mime });

export class BatchQueue {
  readonly items: QueueItem[] = [];
  /** Items currently occupying a heavy slot. A PAUSED item KEEPS its slot
   * (its artifact lease is released at pause; the slot stays held so resume
   * re-enters without re-queueing); cancelled-while-paused releases it. */
  private readonly holding = new Set<string>();

  constructor(private readonly opts: QueueRunnerOptions) {}

  enqueue(plan: QueueItem['plan'], inputs: File[]): QueueItem {
    validatePlan(plan, this.opts.registry, inputs.length);
    const item: QueueItem = {
      id: nextItemId(),
      plan,
      inputs,
      state: 'queued',
      stepIndex: 0,
      artifacts: [],
      progress: 0,
      deliveredIds: new Set<string>(),
    };
    this.items.push(item);
    return item;
  }

  requestPause(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (item && item.state === 'running') item.pauseRequested = true;
  }

  requestCancel(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    const wasPaused = item.state === 'paused';
    const wasAwaiting = item.state === 'awaiting-input';
    item.cancelRequested = true;
    if (item.state === 'queued' || wasPaused || wasAwaiting) {
      transition(item, 'cancelled');
      if (wasPaused) this.holding.delete(item.id); // no parked runItem to clean up
      if (wasAwaiting) {
        const reject = item.parkReject;
        item.parkResolve = undefined;
        item.parkReject = undefined;
        if (reject) reject(new CancelledError()); // un-park the executor
      }
    }
  }

  /** Drive the queue (called by the UI tick / after state changes). */
  async pump(): Promise<void> {
    const maxSlots = this.opts.heavySlots ?? 1;
    for (const item of this.items) {
      if (this.holding.size >= maxSlots) return;
      if (item.state === 'queued') {
        void this.runItem(item);
      }
    }
  }

  private async runItem(item: QueueItem): Promise<void> {
    if (!this.holding.has(item.id)) {
      transition(item, 'running');
      this.holding.add(item.id);
    }
    const lease = artifactRegistry.acquire(`queue:${item.id}`, 'export', { bytes: 0 });
    try {
      let current: { bytes: Uint8Array; name: string; mime: string } | null = null;
      if (item.artifacts.length > 0) {
        current = stepInput(item.artifacts[item.artifacts.length - 1]!);
      }
      for (let s = item.stepIndex; s < item.plan.length; s += 1) {
        if (item.cancelRequested) throw new CancelledError();
        if (item.pauseRequested) {
          item.pauseRequested = false;
          transition(item, 'paused');
          return; // resume() re-enters runItem; slot kept by design
        }
        const step = item.plan[s]!;
        const op = this.opts.registry.get(step.operationId);
        if (!op) throw new QueueValidationError(`unknown operation ${step.operationId}`);
        // inputs for this step: the ORIGINAL files (step 0) or the prior artifact
        const inputs: File[] =
          s === 0
            ? item.inputs
            : current
              ? [new File([new Uint8Array(current.bytes)], current.name, { type: current.mime })]
              : [];
        item.stepIndex = s;
        const outs = await op.run(inputs, step.options, {
          itemId: item.id,
          shouldStop: () => item.cancelRequested === true,
          onProgress: (fraction) => {
            item.progress = Math.min(0.999, (s + fraction) / item.plan.length);
          },
          awaitInput: () =>
            new Promise<void>((resolve, reject) => {
              // PARKS the executor: resolves on resume(), rejects with
              // CancelledError on requestCancel - the item cannot drift to a
              // terminal state while parked (no IllegalTransitionError).
              item.parkResolve = resolve;
              item.parkReject = reject;
              transition(item, 'awaiting-input');
            }),
        });
        if (item.cancelRequested) throw new CancelledError();
        item.artifacts = outs;
        current = stepInput(outs[0]!);
        // progress 1 is RESERVED for delivered output; the cursor advances on
        // COMPLETION (a pause parks AFTER a finished step, never mid-step)
        item.progress = Math.min(0.999, (s + 1) / item.plan.length);
        item.stepIndex = s + 1;
      }
      // DELIVERY with ledger (never duplicate across retry)
      const fresh = item.artifacts.filter((a) => !item.deliveredIds.has(a.artifactId));
      if (fresh.length === 0) {
        transition(item, 'succeeded');
        item.progress = 1;
        return;
      }
      const results = await this.opts.deliver(fresh);
      for (const r of results) {
        if (r.status === 'saved' || r.status === 'dispatched') item.deliveredIds.add(r.artifactId);
      }
      const allDone = item.artifacts.every((a) => item.deliveredIds.has(a.artifactId));
      if (allDone) {
        transition(item, 'succeeded');
        item.progress = 1;
      } else {
        transition(item, 'failed');
        item.error = 'delivery partial/failed (retry delivers ONLY undelivered ids)';
      }
    } catch (e) {
      if (item.state === 'paused') return; // paused inside executor: stay
      if (e instanceof CancelledError) {
        if (item.state !== 'cancelled') transition(item, 'cancelled');
      } else {
        transition(item, 'failed');
        item.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      if (item.state !== 'paused') this.holding.delete(item.id);
      lease.release();
      if (['succeeded', 'failed', 'cancelled'].includes(item.state)) {
        void this.pump(); // slot freed: start the next queued item
      }
    }
  }

  /** Resume paused/failed items. */
  resume(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    if (item.state === 'failed') {
      transition(item, 'queued'); // retry recomputes from stepIndex + artifacts
      void this.pump();
      return;
    }
    if (item.state === 'paused') {
      transition(item, 'running');
      void this.runItem(item); // slot still held from the pause
      return;
    }
    if (item.state === 'awaiting-input') {
      transition(item, 'running');
      const resolve = item.parkResolve;
      const reject = item.parkReject;
      item.parkResolve = undefined;
      item.parkReject = undefined;
      if (item.cancelRequested && reject) reject(new CancelledError());
      else resolve?.();
    }
  }
}

export class CancelledError extends Error {
  constructor() {
    super('queue item cancelled');
    this.name = 'CancelledError';
  }
}
