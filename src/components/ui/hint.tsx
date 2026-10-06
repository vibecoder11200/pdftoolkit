import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangleIcon, InfoIcon, XIcon } from './icons';

interface HintProps {
  variant?: 'info' | 'warning';
  /** sessionStorage key: once dismissed, the hint stays hidden for the tab session. */
  dismissKey: string;
  children: ReactNode;
}

/*
 * Inline guidance note. Dismissal is sessionStorage-scoped (comes back next
 * session) — these carry safety-relevant copy (password loss, untrusted
 * signatures), so unlike a tooltip they must reappear for a fresh session.
 */
export function Hint({ variant = 'info', dismissKey, children }: HintProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem(dismissKey) === '1',
  );
  if (dismissed) return null;
  const dismiss = () => {
    sessionStorage.setItem(dismissKey, '1');
    setDismissed(true);
  };
  const warning = variant === 'warning';
  return (
    <div
      role="note"
      aria-live="polite"
      className={`flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-[13px] ${
        warning
          ? 'border-warning bg-warning-soft text-warning'
          : 'border-border-default bg-surface-page text-text-muted'
      }`}
    >
      <span className="mt-0.5 shrink-0" aria-hidden>
        {warning ? <AlertTriangleIcon size={15} /> : <InfoIcon size={15} />}
      </span>
      <div className="flex-1">{children}</div>
      <button
        type="button"
        aria-label={t('a11y.close')}
        onClick={dismiss}
        className="shrink-0 rounded-md p-1 hover:bg-surface-hover hover:text-text-primary"
      >
        <XIcon size={13} />
      </button>
    </div>
  );
}
