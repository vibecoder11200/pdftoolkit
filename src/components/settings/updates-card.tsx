import { useTranslation } from 'react-i18next';
import { useDesktopUpdateState } from '../../hooks/use-app-update';
import {
  checkForDesktopUpdate,
  startDesktopUpdateInstall,
} from '../../lib/desktop-update-store';
import { isTauri } from '../../lib/platform';

/*
 * "Bản cập nhật" card (v0.5.3 manual check): the updater used to only check
 * on mount/focus/every hour — a user mid-work had to restart the app to
 * re-check. The card exposes an on-demand check and, when one is available,
 * hands the install to the banner (which owns progress, the F22 job confirm
 * and Retry — the store is shared, so both surfaces show the same state).
 * Desktop-only: on the web, updates land through the SW banner on reload.
 */
export function UpdatesCard() {
  const { t, i18n } = useTranslation();
  const state = useDesktopUpdateState();
  if (!isTauri()) return null;

  const checking = state.phase === 'checking';
  const installing =
    state.phase === 'starting' ||
    state.phase === 'downloading' ||
    state.phase === 'installing' ||
    state.phase === 'restarting';

  const lastChecked = state.lastCheckedAt
    ? new Date(state.lastCheckedAt).toLocaleTimeString(i18n.resolvedLanguage === 'en' ? 'en-US' : 'vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : null;

  let status: string;
  switch (state.phase) {
    case 'checking':
      status = t('settings.updates_checking');
      break;
    case 'uptodate':
      status = t('settings.updates_uptodate');
      break;
    case 'check-error':
      status = t('settings.updates_check_error', { message: state.message ?? '' });
      break;
    case 'available':
      status = t('settings.updates_available', { version: state.availableVersion ?? '' });
      break;
    case 'downloading':
      status = t('settings.updates_downloading', { percent: state.percent ?? 0 });
      break;
    case 'starting':
    case 'installing':
    case 'restarting':
      status = t('settings.updates_installing');
      break;
    case 'error':
      status = t('settings.updates_error', { message: state.message ?? '' });
      break;
    default:
      status = t('settings.updates_idle');
  }

  return (
    <section aria-labelledby="settings-updates" className="mt-10 mb-4">
      <h2 id="settings-updates" className="text-lg font-bold">
        {t('settings.updates_title')}
      </h2>
      <div
        data-testid="updates-card"
        className="mt-3 grid gap-2 rounded-xl border border-border-strong px-4 py-3 text-sm"
      >
        <p className="text-text-muted">
          {t('settings.updates_current', { version: `v${__APP_VERSION__}` })} · {__COMMIT_HASH__}
        </p>
        <p data-testid="updates-status" role="status" className={state.phase === 'error' || state.phase === 'check-error' ? 'text-tone-red' : ''}>
          {status}
        </p>
        {lastChecked && !installing && (
          <p className="text-xs text-text-muted">{t('settings.updates_last_checked', { time: lastChecked })}</p>
        )}
        <div className="flex gap-2">
          {!installing && state.phase !== 'available' && (
            <button
              type="button"
              data-testid="updates-check"
              disabled={checking}
              className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm disabled:opacity-50"
              onClick={() => void checkForDesktopUpdate()}
            >
              {t('settings.updates_check')}
            </button>
          )}
          {(state.phase === 'available' || state.phase === 'error') && (
            <button
              type="button"
              data-testid="updates-install"
              className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
              onClick={startDesktopUpdateInstall}
            >
              {state.phase === 'error' ? t('update.desktop_retry') : t('update.reload')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
