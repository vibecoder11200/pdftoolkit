/*
 * ZIP export helper (v0.13.0 phase 2): packs a multi-output run into ONE
 * .zip artifact and delivers it through the single-file seam (1 download on
 * web, 1 native Save-As on desktop) — reusing the phase-3 delivery contract
 * end to end, never touching the session writer.
 *
 * Entry names resolve through resolveBatchNames FIRST (the no-clobber
 * -2..-999 discipline applies INSIDE the zip); a name resolveBatchNames
 * refuses stays on its raw form for zipStore's sanitizer rather than
 * dropping the user's file. A ZipSizeError from the worker (hard 200MB
 * budget crossing comlink — detected BY NAME, see zip.ts) falls back to the
 * multi-download path with `zipped: false` so the caller can surface a
 * notice instead of a dead end (same pattern as pdf-to-img).
 */

import { deliverBytesMulti, type DeliverEntry } from './download';
import type { DeliveryReport } from './delivery-report';
import { isZipSizeError } from './zip';
import { resolveBatchNames } from './delivery-names';

/** Zip packing is opt-in only under this total — safely below the worker's
 * hard ZIP_MAX_TOTAL_BYTES (200MB) and the ~4x transient memory envelope. */
export const ZIP_SOFT_CAP_BYTES = 150 * 1024 * 1024;

/** Toggle visibility verdict for a run's outputs (hosts call BEFORE run too). */
export function zipGateFor(entries: readonly { bytes: Uint8Array }[]): {
  allowed: boolean;
  totalBytes: number;
} {
  let total = 0;
  for (const e of entries) total += e.bytes.byteLength;
  return { allowed: total <= ZIP_SOFT_CAP_BYTES, totalBytes: total };
}

export interface PackZipDeps {
  /** Single-artifact delivery from useDelivery (ledger + retry identity). */
  deliverSingle: (bytes: Uint8Array, filename: string, mime: string) => Promise<DeliveryReport>;
  /** The worker store-only packer (defaults to engine.zipStore). */
  pack?: (entries: { name: string; bytes: Uint8Array }[]) => Promise<Uint8Array>;
  /** Fallback multi-delivery (defaults to deliverBytesMulti). */
  deliverMulti?: (entries: DeliverEntry[], mime: string) => Promise<DeliveryReport>;
}

export interface PackZipOutcome {
  /** False when the run fell back to loose multi delivery (notice case). */
  zipped: boolean;
  /** Single-entry (zip) report on the zip path; multi report on fallback. */
  report: DeliveryReport;
}

export async function packAndDeliverZip(
  entries: DeliverEntry[],
  zipName: string,
  deps: PackZipDeps,
): Promise<PackZipOutcome> {
  if (entries.length === 0) {
    return { zipped: false, report: { overall: 'cancelled', entries: [] } };
  }
  // No-clobber INSIDE the zip: resolveBatchNames applies the -2..-999
  // discipline before packing; refused names ride raw for the sanitizer.
  const resolved = resolveBatchNames(entries.map((e) => e.filename));
  const finalEntries = entries.map((e, i) => {
    const res = resolved[i]!;
    return { name: res.ok ? res.final : e.filename, bytes: e.bytes };
  });

  const pack =
    deps.pack ?? (async (list) => {
      const { engine } = await import('../engine/client');
      return engine.zipStore(list);
    });
  const deliverMulti = deps.deliverMulti ?? deliverBytesMulti;

  let zip: Uint8Array;
  try {
    zip = await pack(finalEntries);
  } catch (e) {
    if (isZipSizeError(e)) {
      // Hard worker budget crossed (comlink strips the prototype — name
      // detection only): deliver loose files, caller shows the notice.
      const report = await deliverMulti(entries, 'application/pdf');
      return { zipped: false, report };
    }
    throw e;
  }
  const report = await deps.deliverSingle(zip, zipName, 'application/zip');
  return { zipped: true, report };
}

// token-mapped
