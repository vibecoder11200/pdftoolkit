// @vitest-environment jsdom
// Handoff store contract: one-shot take (StrictMode safety), replay-on-
// subscribe (launch-banner "open Home" fix), append-on-second-launch, and
// cleared notifications (banner retraction).
import { describe, expect, it, vi } from 'vitest';
import {
  appendPendingFiles,
  clearPendingFiles,
  hasPendingFiles,
  onCleared,
  onPending,
  pendingFileCount,
  setPendingFiles,
  takePendingFiles,
} from '../src/lib/handoff';

const mkFile = (name: string) => new File(['x'], name, { type: 'application/pdf' });

describe('handoff', () => {
  it('take is one-shot — second take returns null (StrictMode safety)', () => {
    setPendingFiles([mkFile('a.pdf')]);
    expect(takePendingFiles()?.files.map((f) => f.name)).toEqual(['a.pdf']);
    expect(takePendingFiles()).toBeNull();
    expect(hasPendingFiles()).toBe(false);
  });

  it('onPending replays the current handoff to a new subscriber', () => {
    setPendingFiles([mkFile('parked.pdf')]);
    const seen: string[][] = [];
    const off = onPending((p) => seen.push(p.files.map((f) => f.name)));
    expect(seen).toEqual([['parked.pdf']]);
    off();
    clearPendingFiles();
  });

  it('appendPendingFiles merges instead of replacing a parked batch', () => {
    setPendingFiles([mkFile('a.pdf')]);
    appendPendingFiles([mkFile('b.pdf'), mkFile('c.pdf')]);
    expect(pendingFileCount()).toBe(3);
    expect(takePendingFiles()?.files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('onCleared fires when a tool takes the files', () => {
    const cleared = vi.fn();
    const off = onCleared(cleared);
    setPendingFiles([mkFile('a.pdf')]);
    expect(cleared).not.toHaveBeenCalled();
    takePendingFiles();
    expect(cleared).toHaveBeenCalledTimes(1);
    off();
  });

  it('onCleared fires on dismiss, and only when something was parked', () => {
    const cleared = vi.fn();
    const off = onCleared(cleared);
    clearPendingFiles(); // nothing parked — silent
    expect(cleared).not.toHaveBeenCalled();
    setPendingFiles([mkFile('a.pdf')]);
    clearPendingFiles();
    expect(cleared).toHaveBeenCalledTimes(1);
    off();
  });
});
