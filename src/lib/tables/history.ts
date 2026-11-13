/*
 * Phase-5 table edit history (plan 261112-0955 step 4). Whole-sheet
 * snapshot undo/redo with the organizer's budget semantics: an explicit
 * flag when a push would DISCARD redo entries or evict the oldest undo
 * entry — the caller confirms, never silent truncation. Spans and hidden
 * (merged) values ride inside the snapshots, so they are reversible.
 */

import { TABLE_HISTORY_BUDGET, type TableSheet } from './model';

export interface TableHistory {
  past: TableSheet[];
  current: TableSheet;
  future: TableSheet[];
  budget: number;
}

export function createTableHistory(initial: TableSheet, budget = TABLE_HISTORY_BUDGET): TableHistory {
  return { past: [], current: initial, future: [], budget };
}

export interface TablePushResult {
  history: TableHistory;
  /** True when pushing DISCARDED redo entries (undo branch rewrite). */
  discardedRedo: number;
  /** True when the oldest undo entry was evicted to stay in budget. */
  evictedUndo: number;
}

export function pushTableSheet(h: TableHistory, next: TableSheet): TablePushResult {
  let past = [...h.past, h.current];
  let future = h.future;
  let discardedRedo = 0;
  let evictedUndo = 0;
  if (future.length > 0) {
    discardedRedo = future.length;
    future = [];
  }
  const limit = Math.max(1, h.budget);
  while (past.length > limit) {
    past = past.slice(1);
    evictedUndo += 1;
  }
  return { history: { past, current: next, future, budget: h.budget }, discardedRedo, evictedUndo };
}

export function undoTable(h: TableHistory): { history: TableHistory; ok: boolean } {
  if (h.past.length === 0) return { history: h, ok: false };
  const previous = h.past[h.past.length - 1]!;
  return {
    history: {
      past: h.past.slice(0, -1),
      current: previous,
      future: [h.current, ...h.future],
      budget: h.budget,
    },
    ok: true,
  };
}

export function redoTable(h: TableHistory): { history: TableHistory; ok: boolean } {
  if (h.future.length === 0) return { history: h, ok: false };
  const [next, ...rest] = h.future;
  return {
    history: {
      past: [...h.past, h.current],
      current: next!,
      future: rest,
      budget: h.budget,
    },
    ok: true,
  };
}
