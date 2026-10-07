import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  clearPendingFiles,
  appendPendingFiles,
  pendingFileCount,
  onCleared,
} from '../../lib/handoff';
import { initLaunchQueue, routeForLaunch } from '../../lib/launch-queue';
import { initDesktopIntake } from '../../lib/desktop-intake';
import { DropOverlay } from './global-drop';

/*
 * OS "open with" landing pad. The launch consumer parks files in the handoff
 * immediately; on home the suggestion sheet picks them up reactively, and on
 * a tool page this banner appears instead of navigating (the running session
 * stays untouched). Dismissing drops the parked files.
 *
 * Desktop (Tauri): initDesktopIntake feeds the SAME handoff from the
 * OS-delivered paths (open-with, drag-drop, cold start) — phase 2 (D13).
 */
export function LaunchBanner() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  const [desktopDragging, setDesktopDragging] = useState(false);
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
        // focus-existing delivers repeated launches — append, never replace.
        appendPendingFiles(files);
        if (routeForLaunch(pathnameRef.current) === 'tool') setCount(pendingFileCount());
      }),
    [],
  );

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void initDesktopIntake({
      onFiles: (files) => {
        // Same semantics as the PWA launch queue: append, never replace.
        appendPendingFiles(files);
        if (routeForLaunch(pathnameRef.current) === 'tool') setCount(pendingFileCount());
      },
      onDragHighlight: setDesktopDragging,
    }).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, []);

  // A tool consuming (or the user dismissing) the parked files must retract
  // the offer — otherwise the banner keeps advertising an empty handoff.
  useEffect(() => onCleared(() => setCount(0)), []);

  if (desktopDragging) return <DropOverlay />;
  if (count === 0) return null;
  return (
    <section
      role="status"
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
