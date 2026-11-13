import {
  applyCommand,
  type OrganizeCommand,
  type OrganizeManifest,
} from './organize-model';

/*
 * Phase-4 organize history: command-patch undo/redo with EXPLICIT budget.
 * Entries hold (command + createdIds + prior manifest) — metadata and
 * instance references, never PDF snapshots. Pushing past the budget flags
 * `discardedUndoEntries` so the CALLER can surface the loss (the plan
 * forbids silent truncation: "on reaching budget ask user before
 * discarding undo history" — `wouldDiscardOnPush` is the pre-push check
 * the UI confirms against). Undo past a branch rewrites the redo tail
 * (classic linear history).
 */

export const HISTORY_BUDGET_DEFAULT = 100;

export interface HistoryEntry {
  cmd: OrganizeCommand;
  /** ids the command created; its inverse deletes exactly these. */
  createdIds: string[];
  /** Deep-frozen prior manifest (instance objects shared, array copied). */
  prior: OrganizeManifest;
}

export interface OrganizeHistory {
  readonly undoStack: readonly HistoryEntry[];
  readonly redoStack: readonly HistoryEntry[];
  readonly current: OrganizeManifest;
}

export function createHistory(initial: OrganizeManifest): OrganizeHistory {
  return { undoStack: [], redoStack: [], current: initial };
}

export function historyBudget(): number {
  return HISTORY_BUDGET_DEFAULT;
}

/** True when the NEXT push would discard undo entries (caller must ask). */
export function wouldDiscardOnPush(hist: OrganizeHistory): boolean {
  return hist.undoStack.length + 1 > HISTORY_BUDGET_DEFAULT;
}

export interface PushResult extends OrganizeHistory {
  discardedUndoEntries: number;
}

export function pushCommand(
  hist: OrganizeHistory,
  cmd: OrganizeCommand,
): PushResult {
  const r = applyCommand(hist.current, cmd);
  const undoStack = [...hist.undoStack, { cmd, createdIds: r.createdIds, prior: hist.current }];
  const discarded = Math.max(0, undoStack.length - HISTORY_BUDGET_DEFAULT);
  return {
    undoStack: discarded > 0 ? undoStack.slice(discarded) : undoStack,
    redoStack: [], // any new command invalidates the redo branch
    current: r.manifest,
    discardedUndoEntries: discarded,
  };
}

export function canUndo(hist: OrganizeHistory): boolean {
  return hist.undoStack.length > 0;
}

export function canRedo(hist: OrganizeHistory): boolean {
  return hist.redoStack.length > 0;
}

export function undo(hist: OrganizeHistory): OrganizeHistory {
  const entry = hist.undoStack[hist.undoStack.length - 1];
  if (!entry) return hist;
  // Inverse of the entry: revert to the stored prior manifest. (For
  // create-commands the createdIds are consumed by nothing — the prior
  // manifest IS the exact inverse state; identity is preserved because
  // instance objects are shared, never copied.)
  const current = entry.prior;
  return {
    undoStack: hist.undoStack.slice(0, -1),
    redoStack: [...hist.redoStack, { cmd: entry.cmd, createdIds: entry.createdIds, prior: current }],
    current,
  };
}

export function redo(hist: OrganizeHistory): OrganizeHistory {
  const entry = hist.redoStack[hist.redoStack.length - 1];
  if (!entry) return hist;
  const r = applyCommand(entry.prior, entry.cmd);
  return {
    undoStack: [...hist.undoStack, entry],
    redoStack: hist.redoStack.slice(0, -1),
    current: { instances: r.manifest.instances },
  };
}

/** Refcount of every source bound by any live page instance across the
 * current manifest AND all history states (undo keeps deleted instances
 * alive). Distinct INSTANCE ids count once even when the same object
 * appears in several states; release a source only at refcount 0.
 * Export-in-flight references are the caller's separate acquire. */
export function computeSourceRefs(
  manifest: OrganizeManifest,
  hist: OrganizeHistory,
): Map<string, number> {
  const perSource = new Map<string, Set<string>>();
  const bump = (p: { sourceId: string | null; instanceId: string }) => {
    if (!p.sourceId) return;
    let ids = perSource.get(p.sourceId);
    if (!ids) {
      ids = new Set();
      perSource.set(p.sourceId, ids);
    }
    ids.add(p.instanceId);
  };
  for (const p of manifest.instances) bump(p);
  for (const e of hist.undoStack) for (const p of e.prior.instances) bump(p);
  for (const e of hist.redoStack) for (const p of e.prior.instances) bump(p);
  for (const p of hist.current.instances) bump(p);
  const refs = new Map<string, number>();
  for (const [sourceId, ids] of perSource) refs.set(sourceId, ids.size);
  return refs;
}
