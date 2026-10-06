import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { clearPendingFiles, setPendingFiles } from '../../lib/handoff';
import { initLaunchQueue, routeForLaunch } from '../../lib/launch-queue';

/*
 * OS "open with" landing pad. The launch consumer parks files in the handoff
 * immediately; on home the suggestion sheet picks them up reactively, and on
 * a tool page this banner appears instead of navigating (the running session
 * stays untouched). Dismissing drops the parked files.
 */
export function LaunchBanner() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  const pathnameRef = useRef(location.pathname);

  useEffect(() => {
    pathnameRef.current = location.pathname;
    // Arriving home resolves the banner either way: the sheet takes over the
    // parked files, so the banner would only duplicate the call to act.
    if (location.pathname === '/') setCount(0);
  }, [location.pathname]);

  useEffect(
    () =>
      initLaunchQueue((files) => {
        setPendingFiles(files);
        if (routeForLaunch(pathnameRef.current) === 'tool') setCount(files.length);
      }),
    [],
  );

  if (count === 0) return null;
  return (
    <section
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-wrap items-center gap-2.5 rounded-lg border border-border-strong bg-surface-card px-4 py-3 shadow-lg"
    >
      <span className="text-[13.5px]">
        {t('home.launch_banner_text', { count })}
      </span>
      <span className="ml-auto flex gap-2">
        <button
          type="button"
          className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
          onClick={() => navigate('/')}
        >
          {t('home.launch_banner_action')}
        </button>
        <button
          type="button"
          className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm"
          onClick={() => {
            clearPendingFiles();
            setCount(0);
          }}
        >
          {t('home.launch_banner_dismiss')}
        </button>
      </span>
    </section>
  );
}
