import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppUpdate, useDesktopUpdate } from '../../hooks/use-app-update';
import type { DesktopUpdateState } from '../../lib/desktop-updater';
import { isTauri } from '../../lib/platform';
import { hasActiveJob } from '../../lib/jobs';

/*
 * "A new version is available" prompt (plan decision D1). Never reloads on
 * its own — the user chooses. Shares the fixed-bottom slot with LaunchBanner;
 * both visible at once is a rare OS-launch-during-deploy edge and either
 * order stays actionable.
 *
 * Desktop (phase 3, D5/R10; v0.5.0 phase 6 fixes F7): the banner stays
 * mounted through the WHOLE flow (available → starting → downloading →
 * installing → restarting → error) — the old predicate hid it the moment
 * downloading began, which made the progress % and errors dead code. The
 * install cannot be cancelled (the plugin API has none — verified in the
 * Rust source), so the copy says so; a running job gets an inline confirm
 * first (F22), and the Update button is disabled outside `available` so a
 * double click cannot spawn a second downloadAndInstall.
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const web = useAppUpdate();
  const desktop = useDesktopUpdate();
  const desktopActive = isTauri();
  const [confirmingJob, setConfirmingJob] = useState(false);
  const phase = desktop.state.phase;
  const visible = desktopActive
    ? DESKTOP_VISIBLE_PHASES.includes(phase)
    : web.bannerVisible;
  if (!visible) return null;
  return (
    <section
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-wrap items-center gap-2.5 rounded-lg border border-border-strong bg-surface-card px-4 py-3 shadow-lg"
    >
      {desktopActive ? (
        <DesktopBody
          state={desktop.state}
          jobBusy={confirmingJob ? false : hasActiveJob()}
          confirmingJob={confirmingJob}
          onConfirmJob={() => setConfirmingJob(true)}
          onCancelConfirm={() => setConfirmingJob(false)}
          onStart={() => {
            setConfirmingJob(false);
            desktop.start();
          }}
        />
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

/** Every phase the desktop banner must survive (the F7 regression set). */
const DESKTOP_VISIBLE_PHASES: DesktopUpdateState['phase'][] = [
  'available',
  'starting',
  'downloading',
  'installing',
  'restarting',
  'error',
];

function DesktopBody({
  state,
  jobBusy,
  confirmingJob,
  onConfirmJob,
  onCancelConfirm,
  onStart,
}: {
  state: DesktopUpdateState;
  jobBusy: boolean;
  confirmingJob: boolean;
  onConfirmJob: () => void;
  onCancelConfirm: () => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  if (state.phase === 'error') {
    return (
      <>
        <span className="text-[13.5px] text-tone-red">
          {t('update.desktop_error', { message: state.message ?? '' })}
        </span>
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            data-testid="update-retry"
            className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
            onClick={onStart}
          >
            {t('update.desktop_retry')}
          </button>
        </span>
      </>
    );
  }
  if (state.phase === 'available') {
    if (confirmingJob || jobBusy) {
      return confirmingJob ? (
        <>
          <span className="text-[13.5px]">{t('update.desktop_confirm_job')}</span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              data-testid="update-confirm"
              className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
              onClick={onStart}
            >
              {t('update.desktop_confirm_continue')}
            </button>
            <button
              type="button"
              data-testid="update-confirm-later"
              className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm"
              onClick={onCancelConfirm}
            >
              {t('update.later')}
            </button>
          </span>
        </>
      ) : (
        <>
          <span className="text-[13.5px]">{t('update.available')}</span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              data-testid="update-reload"
              className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
              onClick={onConfirmJob}
            >
              {t('update.reload')}
            </button>
          </span>
        </>
      );
    }
    return (
      <>
        <span className="text-[13.5px]">{t('update.available')}</span>
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            data-testid="update-reload"
            className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
            onClick={onStart}
          >
            {t('update.reload')}
          </button>
        </span>
      </>
    );
  }
  // starting / downloading / installing / restarting — progress line, no
  // cancel button (the API has none; the copy is honest about that).
  return (
    <>
      <span className="text-[13.5px]">
        {state.phase === 'starting' && t('update.desktop_starting')}
        {state.phase === 'downloading' &&
          t('update.desktop_progress', { percent: state.percent ?? 0 })}
        {state.phase === 'installing' && t('update.desktop_installing')}
        {state.phase === 'restarting' && t('update.desktop_restarting')}
      </span>
      {state.phase === 'downloading' && (
        <span className="w-full text-xs text-text-muted">{t('update.desktop_no_cancel')}</span>
      )}
    </>
  );
}
