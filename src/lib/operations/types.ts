/*
 * Phase-3 typed operation descriptors (scope C shared foundation). A
 * descriptor is the versioned, machine-readable identity of one tool
 * operation: what it accepts, what it produces, what it requires from the
 * user, and its resource budget. Phase 7 (presets/batch queue) consumes
 * this contract; nothing here stores files — inputs flow through the
 * frozen handoff contract, outputs through the delivery report.
 */

export interface OperationRequirements {
  /** Confirmation keys the caller must acknowledge before run (e.g. 'scan-routing'). */
  confirmations?: string[];
  /** The operation needs an AI client (web worker or native engine). */
  model?: boolean;
  /** The operation needs an explicit page selection. */
  selection?: boolean;
}

export interface OperationBudget {
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxPages?: number;
}

export interface OperationProgress {
  done: number;
  total: number;
}

export interface OperationRunContext {
  /** Cooperative cancel: checked BETWEEN pages/stages; a synchronous WASM
   * stage runs to its boundary — never killed mid-op. */
  signal: AbortSignal;
  report: (progress: OperationProgress) => void;
}

export interface OperationDescriptor {
  /** Versioned identity: '<tool>.v1'. Presets store the ID, never files. */
  id: string;
  version: 1;
  label: string;
  inputMime: readonly string[];
  inputCardinality: 1 | 2 | 'many';
  outputMime: string;
  outputCardinality: 1 | 'many';
  requires: OperationRequirements;
  budget: OperationBudget;
  defaultOptions: () => Record<string, unknown>;
  /** Execution adapter. Execution success is NOT delivery success — the
   * caller composes delivery separately through deliverBytesMulti. */
  run: (files: File[], options: Record<string, unknown>, ctx: OperationRunContext) => Promise<unknown>;
}

export type OperationOutcomeStatus = 'complete' | 'cancelled' | 'failed';

export interface OperationRunResult {
  status: OperationOutcomeStatus;
  output?: unknown;
  error?: string;
}
