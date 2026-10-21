// @vitest-environment jsdom
// Handoff store contract: one-shot take (StrictMode safety), replay-on-
// subscribe (launch-banner "open Home" fix), append-on-second-launch, and
// cleared notifications (banner retraction). Plus the chaining chip's
// outputFile contract (v0.8.0 phase 4).
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
import { outputFile } from '../src/lib/output-file';

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

describe('chaining chip outputFile (v0.8.0 phase 4)', () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

  it('builds a PDF File with the given name and snapshot size', () => {
    const f = outputFile(bytes, 'merged.pdf');
    expect(f).toBeInstanceOf(File);
    expect(f.name).toBe('merged.pdf');
    expect(f.type).toBe('application/pdf');
    expect(f.size).toBe(bytes.byteLength);
  });

  it('roundtrips park → take through the handoff with the same name', () => {
    appendPendingFiles([outputFile(bytes, 'chain-me.pdf')]);
    const taken = takePendingFiles();
    expect(taken?.files.map((f) => f.name)).toEqual(['chain-me.pdf']);
  });

  it('append-after-park keeps a previously parked OS-launch batch (finding 5)', () => {
    // The chip parks via appendPendingFiles — a parked launch batch must
    // survive the chip handoff (setPendingFiles REPLACE would clobber it).
    setPendingFiles([mkFile('os-launch.pdf')]);
    appendPendingFiles([outputFile(bytes, 'from-chip.pdf')]);
    expect(pendingFileCount()).toBe(2);
    expect(takePendingFiles()?.files.map((f) => f.name)).toEqual(['os-launch.pdf', 'from-chip.pdf']);
  });
});
