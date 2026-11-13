import { useCallback, useRef, useState } from 'react';
import {
  deliveryOverall,
  retentionBudgetOk,
  type DeliveryReport,
} from './delivery-report';
import { deliverBytesMulti, type DeliverEntry } from './download';

/*
 * Phase-3 delivery state for tool pages: one deliver call site per tool
 * that consumes the typed report, retains failed bytes ONLY within the
 * explicit retry budget, and re-delivers failed entries with their ORIGINAL
 * artifact ids (the success ledger — delivered entries are never re-sent).
 * Complete/dispatched/cancelled reports are not surfaced; partial/failed
 * render the shared DeliveryReportBar.
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
    const r = await deliverBytesMulti(failedEntries, mimeRef.current ?? 'application/pdf');
    const merged = current.entries.map((e) => {
      const replacement = r.entries.find((x) => x.artifactId === e.artifactId);
      return replacement ?? e;
    });
    const next: DeliveryReport = { overall: deliveryOverall(merged), entries: merged };
    if (next.overall === 'complete' || next.overall === 'dispatched') setReport(null);
    else setReport(next);
    return next;
  }, [report]);

  const dismiss = useCallback(() => setReport(null), []);

  const clear = useCallback(() => {
    entriesRef.current = null;
    setReport(null);
  }, []);

  return { report, deliver, retry, dismiss, clear, canRetry: budgetOkRef.current };
}
