import { useTranslation } from 'react-i18next';
import { useAppUpdate, useDesktopUpdate } from '../../hooks/use-app-update';
import { isTauri } from '../../lib/platform';

/*
 * "A new version is available" prompt (plan decision D1). Never reloads on
 * its own — the user chooses. Shares the fixed-bottom slot with LaunchBanner;
 * both visible at once is a rare OS-launch-during-deploy edge and either
 * order stays actionable.
 *
 * Desktop (phase 3, D5/R10): the same banner drives the Tauri updater —
 * "Cập nhật ngay" runs check → downloadAndInstall with %, then relaunch.
 * On Windows the relaunch is fire-and-forget (the NSIS install kills the
 * running app) so the copy promises "the app restarts itself" instead of
 * awaiting.
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const web = useAppUpdate();
  const desktop = useDesktopUpdate();
  const desktopActive = isTauri();
  const visible = desktopActive
    ? desktop.state.phase === 'available'
    : web.bannerVisible;
  if (!visible) return null;
  return (
    <section
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-wrap items-center gap-2.5 rounded-lg border border-border-strong bg-surface-card px-4 py-3 shadow-lg"
    >
      {desktopActive ? (
        desktop.state.phase === 'available' ? (
          <>
            <span className="text-[13.5px]">{t('update.available')}</span>
            <span className="ml-auto flex gap-2">
              <button
                type="button"
                data-testid="update-reload"
                className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
                onClick={desktop.start}
              >
                {t('update.reload')}
              </button>
            </span>
          </>
        ) : (
          <span className="text-[13.5px]">
            {desktop.state.phase === 'downloading'
              ? t('update.desktop_progress', { percent: desktop.state.percent ?? 0 })
              : t('update.desktop_restarting')}
          </span>
        )
      ) : (
        <>
          <span className="text-[13.5px]">{t('update.available')}</span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              data-testid="update-reload"
              className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
              onClick={web.applyUpdate}
            >
              {t('update.reload')}
            </button>
            <button
              type="button"
              data-testid="update-later"
              className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm"
              onClick={web.dismiss}
            >
              {t('update.later')}
            </button>
          </span>
        </>
      )}
    </section>
  );
}
