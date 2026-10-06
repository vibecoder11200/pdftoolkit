import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Logo } from '../ui/logo';
import { useAppUpdate } from '../../hooks/use-app-update';

const REPO_URL = 'https://github.com/vibecoder11200/pdftoolkit';

/*
 * Minimal footer with a pulse (plan decision D2): logo mark + name, version
 * chip (build-time __APP_VERSION__ + short commit hash — the hash doubles as
 * the user-visible proof that an update landed after a reload), MIT, GitHub,
 * update dot (only while a new version waits; click = apply + reload) and
 * the tour replay.
 */
export function Footer() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { hasWaiting, applyUpdate } = useAppUpdate();

  const replayTour = () => {
    try {
      localStorage.setItem('pdftoolkit-tour-replay', '1');
      localStorage.removeItem('pdftoolkit-tour-done');
    } catch {
      /* storage unavailable */
    }
    // The mounted Tour checks nothing on its own — the event reaches it when
    // the footer is on the same page; the flag covers the cross-page case.
    window.dispatchEvent(new Event('pdftoolkit:tour-replay'));
    if (location.pathname !== '/') navigate('/');
  };

  return (
    <footer className="mt-13 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border-default pt-5 text-[13px] text-text-muted">
      <span className="flex items-center gap-2">
        <Logo size={16} />
        <strong className="text-text-primary">PDF Toolkit</strong>
      </span>
      <span
        data-testid="footer-version"
        className="rounded-full border border-border-strong px-2 py-0.5 text-xs tabular-nums"
        aria-label={t('footer.version_aria', { version: `v${__APP_VERSION__}` })}
      >
        v{__APP_VERSION__} · {__COMMIT_HASH__}
      </span>
      <span className="text-xs">MIT</span>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('footer.github_aria')}
        className="rounded-md p-1 hover:bg-surface-hover hover:text-text-primary"
      >
        <GithubIcon />
      </a>
      {hasWaiting ? (
        <button
          type="button"
          data-testid="update-dot"
          title={t('update.dot_aria')}
          aria-label={t('update.dot_aria')}
          onClick={applyUpdate}
          className="flex items-center gap-1.5 rounded-full border border-border-strong px-2 py-0.5 text-xs hover:bg-surface-hover hover:text-text-primary"
        >
          <span aria-hidden className="h-2 w-2 rounded-full bg-accent animate-pulse" />
          {t('update.available_short')}
        </button>
      ) : null}
      <button
        type="button"
        className="ml-auto min-h-9 rounded-lg border border-border-strong px-3 hover:bg-surface-hover hover:text-text-primary"
        onClick={replayTour}
      >
        {t('footer.replay_tour')}
      </button>
    </footer>
  );
}

function GithubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

// token-mapped
