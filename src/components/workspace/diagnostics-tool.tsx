import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDropFiles } from '../../hooks/use-drop-files';
import { takePendingFiles } from '../../lib/handoff';
import { runDiagnostics, type PdfDiagReport } from '../../lib/pdf-diagnostics';
import { RepairRefusedError, runRepair } from '../../lib/pdf-repair';
import { useDelivery } from '../../lib/use-delivery';
import { DeliveryReportBar } from './delivery-report-bar';
import { Dropzone } from '../ui/dropzone';
import { Hint } from '../ui/hint';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';

/*
 * Tool #24 diagnostics (phase 8): read-only structural report + user-
 * triggered best-effort repair. The report is NOT a security scan and exit
 * 0 is not a semantic guarantee (disclosed in-card). Repair writes NEW
 * output only; an unverifiable result (unreadable original) is labelled as
 * requiring review — never presented as verified.
 */

const STEPS = ['pick', 'report', 'repair'] as const;

export function DiagnosticsTool() {
  const { t } = useTranslation(['common']);
  const { files, error: fileError, add, clear } = useDropFiles();
  const [report, setReport] = useState<PdfDiagReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [repairNote, setRepairNote] = useState<string | null>(null);
  const { deliver, retry, dismiss, report: delivery, canRetry } = useDelivery();
  const file = files[0] ?? null;

  // Pending-file intake (ContinueChip destination; acceptsPdf tool).
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);

  const reset = () => {
    clear();
    setReport(null);
    setRunError(null);
    setRepairNote(null);
  };

  const diagnose = async () => {
    if (!file) return;
    setBusy(true);
    setRunError(null);
    try {
      const bytes = file.bytes;
      setReport(await runDiagnostics(bytes));
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const repair = async () => {
    if (!file) return;
    setBusy(true);
    setRunError(null);
    setRepairNote(null);
    try {
      const bytes = file.bytes;
      const out = await runRepair(bytes, file.file.name);
      await deliver([{ bytes: out.bytes, filename: out.filename, artifactId: 'repair:0' }]);
      setRepairNote(
        out.verification === 'verified' ? t('diag.repair_verified') : t('diag.repair_unverifiable'),
      );
    } catch (e) {
      if (e instanceof RepairRefusedError) {
        setRunError(t('diag.repair_refused', { detail: e.detail }));
      } else {
        setRunError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <WorkspaceShell
      title={t('diag.title')}
      meta={file ? file.file.name : undefined}
      steps={STEPS.map((key, i) => ({
        key,
        label: t('diag.step_' + key),
        state: (i === 0 && file) || (i === 1 && report) ? 'done' : i === 0 ? 'now' : 'todo',
      }))}
      error={runError ?? (fileError ? { title: fileError } : null)}
      onReset={reset}
      side={
        <div className="flex flex-col gap-3">
          <Hint dismissKey="diag-hint">{t('diag.hint')}</Hint>
          <Button disabled={!file || busy} data-testid="diag-run" onClick={() => void diagnose()}>
            {t('diag.run')}
          </Button>
          <Button variant="ghost" disabled={!file || busy} data-testid="diag-repair" onClick={() => void repair()}>
            {t('diag.repair_cta')}
          </Button>
        </div>
      }
    >
      <Dropzone
        onFiles={(fs) => void add(fs.slice(0, 1))}
        accept=".pdf"
        title={t('diag.drop')}
        hint={t('diag.hint')}
      />
      {report ? (
        <div data-testid="diag-report" className="mt-4 flex flex-col gap-2.5 rounded-xl border border-border-default px-4 py-3.5">
          <p className="text-[14px] font-semibold">{t('diag.report_title')}</p>
          <ul className="flex flex-col gap-1.5 text-[13.5px] text-text-primary">
            <li data-testid="diag-readable">
              {t('diag.readable')}: {report.readable ? t('diag.yes') : t('diag.no')}
            </li>
            {report.encrypted ? (
              <li data-testid="diag-encrypted">
                {t('diag.encrypted')}
                {report.needsPassword ? ' — ' + t('diag.needs_password') : ''}
              </li>
            ) : null}
            {report.pageCount !== null ? <li>{t('diag.pages')}: {report.pageCount}</li> : null}
            <li>{t('diag.qpdf_exit')}: {report.qpdfExit === null ? '—' : report.qpdfExit}</li>
            {report.warnings.length > 0 ? (
              <li className="text-text-muted">
                {t('diag.warnings')}:
                <ul className="mt-1.5 list-inside list-disc">
                  {report.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </li>
            ) : null}
          </ul>
          <p className="text-[12.5px] text-text-muted">{t('diag.not_security')}</p>
        </div>
      ) : null}
      {repairNote ? (
        <p data-testid="diag-repair-note" className="mt-3 text-[13.5px] text-text-primary">
          {repairNote}
        </p>
      ) : null}
      {delivery ? (
        <DeliveryReportBar
          report={delivery}
          canRetry={canRetry}
          busy={busy}
          onRetry={() => void retry()}
          onDismiss={dismiss}
        />
      ) : null}
    </WorkspaceShell>
  );
}
