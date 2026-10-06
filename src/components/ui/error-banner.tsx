import { useTranslation } from 'react-i18next';
import { AlertTriangleIcon } from './icons';
import { Button } from './button';

export interface ErrorDetail {
  title: string;
  detail?: string;
  onRetry?: () => void;
}

/**
 * Standard alert: role=alert, warning icon, bold title, optional secondary
 * detail and a retry action. Tools pass either this object or a plain string
 * (wrapped for compatibility with the pre-phase-3 call sites).
 */
export function ErrorBanner({ error }: { error: string | ErrorDetail }) {
  const { t } = useTranslation();
  const normalized: ErrorDetail = typeof error === 'string' ? { title: error } : error;
  return (
    <div
      role="alert"
      className="mb-3.5 flex items-start gap-2.5 rounded-lg border border-danger bg-danger-soft px-4 py-3 text-[13.5px]"
    >
      <span className="mt-0.5 shrink-0 text-danger">
        <AlertTriangleIcon size={17} />
      </span>
      <div className="min-w-0">
        <p className="font-bold text-danger">{normalized.title}</p>
        {normalized.detail ? <p className="mt-0.5 text-text-muted">{normalized.detail}</p> : null}
        {normalized.onRetry ? (
          <Button variant="secondary" size="sm" className="mt-2" onClick={normalized.onRetry}>
            {t('a11y.retry')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
