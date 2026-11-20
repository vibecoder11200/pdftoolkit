import { describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import {
  ZIP_SOFT_CAP_BYTES,
  packAndDeliverZip,
  zipGateFor,
  type PackZipDeps,
} from '../src/lib/deliver-zip';
import { ZIP_MAX_TOTAL_BYTES, ZipSizeError, zipStore } from '../src/lib/zip';
import type { DeliveryReport } from '../src/lib/delivery-report';
import type { DeliverEntry } from '../src/lib/download';

/*
 * v0.13.0 phase 2 — packAndDeliverZip: entry names resolve through
 * resolveBatchNames (no-clobber INSIDE the zip, verified by unzipping the
 * packed bytes), mime application/zip on the single seam, soft-cap gate,
 * and the by-name ZipSizeError fallback to loose multi delivery.
 */

const KB = 1024;
const b = (n: number) => new Uint8Array(n);
const okReport = (name: string): DeliveryReport => ({
  overall: 'dispatched',
  entries: [{ artifactId: 'a', filename: name, status: 'dispatched' }],
});

function makeDeps() {
  const packed: { name: string; bytes: Uint8Array }[][] = [];
  const deps: PackZipDeps = {
    deliverSingle: vi.fn(async (_bytes: Uint8Array, filename: string, mime: string) => {
      expect(mime).toBe('application/zip');
      return okReport(filename);
    }),
    pack: vi.fn(async (entries) => {
      packed.push(entries);
      return zipStore(entries);
    }),
    deliverMulti: vi.fn(async (entries: DeliverEntry[]): Promise<DeliveryReport> => ({
      overall: 'dispatched',
      entries: entries.map((e, i) => ({
        artifactId: `m${i}`,
        filename: e.filename,
        status: 'dispatched' as const,
      })),
    })),
  };
  return { deps, packed };
}

describe('zipGateFor — soft-cap verdict', () => {
  it('allows runs under the 150MB soft cap (below the worker hard cap)', () => {
    expect(ZIP_SOFT_CAP_BYTES).toBeLessThan(ZIP_MAX_TOTAL_BYTES);
    const gate = zipGateFor([{ bytes: b(10 * KB) }, { bytes: b(10 * KB) }]);
    expect(gate.allowed).toBe(true);
    expect(gate.totalBytes).toBe(20 * KB);
  });

  it('disallows runs over the soft cap (host hides the toggle)', () => {
    const gate = zipGateFor([{ bytes: b(ZIP_SOFT_CAP_BYTES + 1) }]);
    expect(gate.allowed).toBe(false);
  });
});

describe('packAndDeliverZip — happy path', () => {
  it('resolves duplicate names through resolveBatchNames INSIDE the zip', async () => {
    const { deps, packed } = makeDeps();
    const outcome = await packAndDeliverZip(
      [
        { bytes: b(10), filename: 'tai-lieu.pdf' },
        { bytes: b(11), filename: 'tai-lieu.pdf' },
      ],
      'split-tap-hop.zip',
      deps,
    );
    expect(outcome.zipped).toBe(true);
    expect(packed[0]!.map((e) => e.name).sort()).toEqual(['tai-lieu-2.pdf', 'tai-lieu.pdf']);
    // Byte-truth: unzip the packed zip and match the entry names.
    const zip = zipStore(packed[0]!);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(['tai-lieu-2.pdf', 'tai-lieu.pdf']);
    expect(deps.deliverSingle).toHaveBeenCalledTimes(1);
    expect(deps.deliverMulti).not.toHaveBeenCalled();
  });

  it('keeps refused names on their raw form for the zip sanitizer (never drops)', async () => {
    const { deps, packed } = makeDeps();
    await packAndDeliverZip(
      [{ bytes: b(5), filename: 'bad/path.pdf' }],
      'x.zip',
      deps,
    );
    // resolveBatchNames refuses separators; packAndDeliverZip passes the raw
    // name through (zipStore.sanitizeEntryName turns it into 'bad path.pdf').
    expect(packed[0]![0]!.name).toBe('bad/path.pdf');
    const zip = zipStore(packed[0]!);
    expect(Object.keys(unzipSync(zip))).toEqual(['bad path.pdf']);
  });

  it('hands the single seam exactly one application/zip artifact', async () => {
    const { deps } = makeDeps();
    const outcome = await packAndDeliverZip(
      [
        { bytes: b(4), filename: 'a.pdf' },
        { bytes: b(4), filename: 'b.pdf' },
      ],
      'gop.zip',
      deps,
    );
    expect(outcome.zipped).toBe(true);
    expect(outcome.report.entries[0]!.filename).toBe('gop.zip');
    const single = deps.deliverSingle as ReturnType<typeof vi.fn>;
    expect(single.mock.calls[0]![2]).toBe('application/zip');
  });

  it('returns cancelled for an empty run', async () => {
    const { deps } = makeDeps();
    const outcome = await packAndDeliverZip([], 'x.zip', deps);
    expect(outcome.zipped).toBe(false);
    expect(outcome.report.overall).toBe('cancelled');
    expect(deps.pack).not.toHaveBeenCalled();
  });
});

describe('packAndDeliverZip — ZipSizeError fallback (name-based detection)', () => {
  it('falls back to loose multi delivery when the worker budget is crossed', async () => {
    const entries = [
      { bytes: b(6), filename: 'f1.pdf' },
      { bytes: b(7), filename: 'f2.pdf' },
    ];
    const { deps } = makeDeps();
    (deps.pack as ReturnType<typeof vi.fn>).mockRejectedValue(new ZipSizeError(201 * MB()));
    const outcome = await packAndDeliverZip(entries, 'x.zip', deps);
    expect(outcome.zipped).toBe(false);
    expect(deps.deliverMulti).toHaveBeenCalledTimes(1);
    expect((deps.deliverMulti as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual(entries);
    expect(deps.deliverSingle).not.toHaveBeenCalled();
    expect(outcome.report.overall).toBe('dispatched');
  });

  it('matches a prototype-stripped ZipSizeError across comlink (name only)', async () => {
    const entries = [{ bytes: b(6), filename: 'f.pdf' }];
    const { deps } = makeDeps();
    const rebuilt = new Error('zip input exceeds budget');
    rebuilt.name = 'ZipSizeError';
    (deps.pack as ReturnType<typeof vi.fn>).mockRejectedValue(rebuilt);
    const outcome = await packAndDeliverZip(entries, 'x.zip', deps);
    expect(outcome.zipped).toBe(false);
    expect(deps.deliverMulti).toHaveBeenCalled();
  });

  it('propagates non-size pack errors (ErrorBanner surface, no silent crash)', async () => {
    const { deps } = makeDeps();
    (deps.pack as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('zipStore supports at most 65535 entries (got 70000)'),
    );
    await expect(
      packAndDeliverZip([{ bytes: b(3), filename: 'a.pdf' }], 'x.zip', deps),
    ).rejects.toThrow(/65535/);
    expect(deps.deliverMulti).not.toHaveBeenCalled();
  });
});

function MB(): number {
  return 1024 * 1024;
}
