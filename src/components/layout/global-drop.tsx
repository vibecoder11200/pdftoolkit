import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri } from '../../lib/platform';

/**
 * The drag visual shared by the web DOM catcher (GlobalDrop) and the desktop
 * intake overlay (launch-banner mounts it for Tauri drag events, which the
 * webview intercepts before they ever become DOM drop events).
 */
export function DropOverlay() {
  const { t } = useTranslation();
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[90] grid place-items-center bg-surface-page/85 p-8"
      aria-hidden
    >
      <div className="grid w-full max-w-2xl place-items-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-accent-soft px-6 py-14 text-center">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
          <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <p className="text-lg font-bold">{t('home.drop_here')}</p>
      </div>
    </div>
  );
}

/**
 * Window-level drop catcher for the home page. Only reacts to file drags
 * (dataTransfer contains the `Files` type); a drop anywhere prevents the
 * browser's default "open the file" behavior. The classification + sheet
 * flow lives in the parent via onFiles.
 *
 * Desktop (Tauri): the webview intercepts file drops before they become DOM
 * events (delivery arrives via the Rust emit in desktop-intake.ts), so the
 * DOM catcher must stay inert — otherwise it would double-deliver the drop.
 * The overlay for desktop drags comes from the intake's onDragDropEvent.
 */
export function GlobalDrop({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (isTauri()) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onFiles(files);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onFiles]);

  if (dragging && !isTauri()) return <DropOverlay />;
  return null;
}
