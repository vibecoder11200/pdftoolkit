import { beginJob, endJob } from '../jobs';
import type {
  OperationDescriptor,
  OperationRunContext,
  OperationRunResult,
} from './types';

/*
 * Phase-3 minimal operation runner. Contract:
 * - beginJob/endJob brackets the run in a FINALLY (update-banner + shared
 *   resource visibility; release even on crash).
 * - Execution success != delivery success — the runner returns the raw
 *   output; delivery composition stays with the caller.
 * - No auto replay after crash: a failed op is reported, never retried
 *   silently.
 * - Cooperative cancel via AbortSignal checked between pages/stages; a
 *   synchronous WASM stage runs to its boundary.
 */

export interface OperationHandle {
  result: Promise<OperationRunResult>;
  cancel: () => void;
}

export function startOperation(
  desc: OperationDescriptor,
  files: File[],
  options: Record<string, unknown>,
  hooks: { onProgress?: (done: number, total: number) => void } = {},
): OperationHandle {
  const controller = new AbortController();
  const jobId = `op:${desc.id}`;
  const result = (async (): Promise<OperationRunResult> => {
    // Budget gate BEFORE any work (typed refusal, never silent truncation).
    for (const f of files) {
      if (desc.budget.maxInputBytes !== undefined && f.size > desc.budget.maxInputBytes) {
        return { status: 'failed', error: 'input exceeds operation budget' };
      }
    }
    // Confirmation requirements: acknowledged options only.
    const missing = (desc.requires.confirmations ?? []).filter(
      (key) => options[`confirm_${key}`] !== true,
    );
    if (missing.length > 0) {
      return { status: 'failed', error: `missing confirmation: ${missing[0]}` };
    }
    beginJob(jobId);
    try {
      const ctx: OperationRunContext = {
        signal: controller.signal,
        report: (p) => hooks.onProgress?.(p.done, p.total),
      };
      const output = await desc.run(files, options, ctx);
      return { status: 'complete', output };
    } catch (e) {
      if (controller.signal.aborted) {
        return { status: 'cancelled' };
      }
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    } finally {
      endJob(jobId);
    }
  })();
  return { result, cancel: () => controller.abort() };
}
