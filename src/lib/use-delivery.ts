import { useCallback, useRef, useState } from 'react';
import {
  deliveryOverall,
  retentionBudgetOk,
  type DeliveryEntry,
  type DeliveryReport,
} from './delivery-report';
import { deliverBytes, deliverBytesMulti, type DeliverEntry } from './download';
import { isDesktopSaveAvailable } from './desktop-save';

/*
 * Phase-3 delivery state for tool pages: one deliver call site per tool
 * that consumes the typed report, retains failed bytes ONLY within the
 * explicit retry budget, and re-delivers failed entries with their ORIGINAL
 * artifact ids (the success ledger — delivered entries are never re-sent).
 * Complete/dispatched/cancelled reports are not surfaced; partial/failed
 * render the shared DeliveryReportBar.
 *
 * v0.13.0 phase 2 (ADDITIVE): deliverSingle packs the ZIP-export path —
 * one artifact through deliverBytes (native Save-As on desktop, one
 * download on web), ledger identity + retry routed by mime so a failed zip
 * save retries AS A ZIP, never through the multi/session-writer path.
 */

let runCounter = 0;

export function useDelivery() {
  const [report, setReport] = useState<DeliveryReport | null>(null);
  const entriesRef = useRef<DeliverEntry[] | null>(null);
  const mimeRef = useRef('application/pdf');
  const budgetOkRef = useRef<boolean>(true);

  const deliver = useCallback(async (entries: DeliverEntry[], mime?: string) => {
    runCounter += 1;
    const runId = `r${runCounter}-${Date.now().toString(36)}`;
    const tagged = entries.map((e, i) => ({
      ...e,
      artifactId: e.artifactId ?? `${runId}:${i}`,
    }));
    if (mime) mimeRef.current = mime;
    entriesRef.current = retentionBudgetOk(tagged) ? tagged : null;
    budgetOkRef.current = retentionBudgetOk(tagged);
    const r = await deliverBytesMulti(tagged, mimeRef.current);
    if (r.overall === 'complete' || r.overall === 'dispatched' || r.overall === 'cancelled') {
      setReport(null);
    } else {
      setReport(r);
    }
    return r;
  }, []);

  const deliverSingle = useCallback(
    async (bytes: Uint8Array, filename: string, mime = 'application/zip') => {
      runCounter += 1;
      const runId = `r${runCounter}-${Date.now().toString(36)}`;
      const entry: DeliverEntry = { bytes, filename, artifactId: `${runId}:zip` };
      const ok = retentionBudgetOk([entry]);
      entriesRef.current = ok ? [entry] : null;
      budgetOkRef.current = ok;
      mimeRef.current = mime;
      const delivered = await deliverBytes(bytes, filename, 'download', mime);
      const status: DeliveryEntry['status'] = delivered
        ? isDesktopSaveAvailable()
          ? 'saved'
          : 'dispatched'
        : 'failed';
      const result: DeliveryReport = {
        overall: delivered ? (isDesktopSaveAvailable() ? 'complete' : 'dispatched') : 'failed',
        entries: [
          {
            artifactId: entry.artifactId!,
            filename,
            status,
            ...(delivered ? {} : { error: 'cancelled' }),
          },
        ],
      };
      if (result.overall === 'complete' || result.overall === 'dispatched') setReport(null);
      else setReport(result);
      return result;
    },
    [],
  );

  const retry = useCallback(async () => {
    const current = report;
    const bytes = entriesRef.current;
    if (!current || !bytes) return null;
    const failedIds = new Set(
      current.entries.filter((e) => e.status === 'failed').map((e) => e.artifactId),
    );
    const failedEntries = bytes.filter(
      (e) => e.artifactId !== undefined && failedIds.has(e.artifactId),
    );
    if (failedEntries.length === 0) return null;
    if (mimeRef.current === 'application/zip') {
      // The ZIP single path retries AS A ZIP (deliverBytes — native Save-As
      // on desktop, one download on web), never the multi/session writer.
      const single = await deliverSingle(
        failedEntries[0]!.bytes,
        failedEntries[0]!.filename,
        'application/zip',
      );
      return single;
    }
    const r = await deliverBytesMulti(failedEntries, mimeRef.current ?? 'application/pdf');
    const merged = current.entries.map((e) => {
      const replacement = r.entries.find((x) => x.artifactId === e.artifactId);
      return replacement ?? e;
    });
    const next: DeliveryReport = { overall: deliveryOverall(merged), entries: merged };
    if (next.overall === 'complete' || next.overall === 'dispatched') setReport(null);
    else setReport(next);
    return next;
  }, [report, deliverSingle]);

  const dismiss = useCallback(() => setReport(null), []);

  const clear = useCallback(() => {
    entriesRef.current = null;
    setReport(null);
  }, []);

  return { report, deliver, deliverSingle, retry, dismiss, clear, canRetry: budgetOkRef.current };
}
