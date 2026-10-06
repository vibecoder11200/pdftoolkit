import { useTranslation } from 'react-i18next';
import { useAppUpdate } from '../../hooks/use-app-update';

/*
 * "A new version is available" prompt (plan decision D1). Never reloads on
 * its own — the user chooses. Shares the fixed-bottom slot with LaunchBanner;
 * both visible at once is a rare OS-launch-during-deploy edge and either
 * order stays actionable.
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const { bannerVisible, applyUpdate, dismiss } = useAppUpdate();
  if (!bannerVisible) return null;
  return (
    <section
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-wrap items-center gap-2.5 rounded-lg border border-border-strong bg-surface-card px-4 py-3 shadow-lg"
    >
      <span className="text-[13.5px]">{t('update.available')}</span>
      <span className="ml-auto flex gap-2">
        <button
          type="button"
          data-testid="update-reload"
          className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
          onClick={applyUpdate}
        >
          {t('update.reload')}
        </button>
        <button
          type="button"
          data-testid="update-later"
          className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm"
          onClick={dismiss}
        >
          {t('update.later')}
        </button>
      </span>
    </section>
  );
}
