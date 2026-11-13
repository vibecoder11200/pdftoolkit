import { useTranslation } from 'react-i18next';

import { RETRY_RETENTION_BUDGET, type DeliveryReport } from '../../lib/delivery-report';
import { formatBytes } from '../../lib/format';

/*
 * Phase-3 shared delivery report UI: rendered by multi-output tools when
 * their deliver reports partial/failed. Lists per-entry outcomes with a
 * retry affordance for failed entries (skipped = name-invalid entries are
 * NOT retryable - a re-run with different names is required). Retry bytes
 * are retained only within RETRY_RETENTION_BUDGET; above it the retry is
 * disabled with an honest re-run note instead of unbounded retention.
 */

export function DeliveryReportBar({
  report,
  onRetry,
  onDismiss,
  canRetry,
  busy,
}: {
  report: DeliveryReport;
  onRetry?: () => void;
  onDismiss?: () => void;
  canRetry?: boolean;
  busy?: boolean;
}) {
  const { t } = useTranslation(['common', 'tools']);
  const failed = report.entries.filter((e) => e.status === 'failed');
  const skippedCount = report.entries.filter(
    (e) => e.status === 'failed' || e.status === 'skipped',
  ).length;
  const retryable = failed.length > 0 && (canRetry ?? true) && !!onRetry;
  return (
    <div
      role="status"
      data-testid="delivery-report-bar"
      className={`rounded-lg border px-3 py-2 text-[13px] ${
        failed.length > 0
          ? 'border-danger/40 bg-danger-soft text-text-primary'
          : 'border-border-strong bg-surface-card text-text-primary'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">
          {failed.length > 0
            ? t('delivery.partial', { n: failed.length })
            : t('delivery.skipped_only', { n: skippedCount })}
        </span>
        <div className="flex items-center gap-2">
          {retryable && (
            <button
              type="button"
              data-testid="delivery-retry"
              onClick={onRetry}
              disabled={busy}
              className="min-h-9 rounded-lg border border-accent px-3 py-1.5 font-semibold text-accent disabled:opacity-50"
            >
              {t('delivery.retry')}
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              data-testid="delivery-dismiss"
              onClick={onDismiss
              }
              className="min-h-9 rounded-lg border border-border-strong px-3 py-1.5 text-text-muted"
            >
              {t('delivery.dismiss')}
            </button>
          )}
        </div>
      </div>
      <ul className="mt-1.5 space-y-0.5" data-testid="delivery-entries">
        {report.entries.map((entry) => (
          <li key={entry.artifactId} className="flex items-center justify-between gap-2">
            <span className="truncate">{entry.filename}</span>
            <span
              className={
                entry.status === 'failed' || entry.status === 'skipped'
                  ? 'text-danger'
                  : 'text-text-muted'
              }
            >
              {entry.status === 'saved'
                ? t('delivery.saved')
                : entry.status === 'dispatched'
                  ? t('delivery.dispatched')
                  : entry.status === 'failed'
                    ? t('delivery.failed')
                    : t('delivery.skipped')}
            </span>
          </li>
        ))}
      </ul>
      {canRetry === false && failed.length > 0 && (
        <p className="mt-1 text-xs text-text-muted">
          {t('delivery.retain_exceeded', { size: formatBytes(RETRY_RETENTION_BUDGET) })}
        </p>
      )}
    </div>
  );
}
