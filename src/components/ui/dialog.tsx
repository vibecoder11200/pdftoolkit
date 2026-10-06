import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, title, children }: DialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Latest-closure indirection so the lifecycle effect can depend on `open`
  // alone: re-keying on onClose (an inline arrow in every consumer) would
  // re-run focus restore/re-capture on each parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const first = container?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? container)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === container)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreTo?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="fixed inset-0 z-[100] grid place-items-center bg-surface-overlay/85 p-4 outline-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-2xl overflow-auto rounded-xl bg-surface-card p-5">
        <div className="mb-3 flex items-center gap-2 font-bold">
          <span>{title}</span>
          <button
            type="button"
            className="ml-auto min-h-9 min-w-9 rounded-lg border border-border-strong px-3 text-sm"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// token-mapped
