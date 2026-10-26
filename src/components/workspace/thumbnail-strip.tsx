import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../ui/dialog';
import { CheckIcon, ExpandIcon } from '../ui/icons';

interface PageThumb {
  key: string;
  pageNumber: number;
  url: string | null;
  selected: boolean;
}

interface ThumbnailStripProps {
  pages: PageThumb[];
  fullscreenTitle: (n: number) => string;
  closeLabel: string;
  onToggle: (pageNumber: number, index: number) => void;
  onMove?: (from: number, to: number) => void;
  /** When set (with onMove): Alt+←/→ moves the focused cell, hint renders above the grid. */
  keyboardMoveHint?: string;
  /** Lazy-render hook: registers each cell so it renders when visible. */
  register?: (key: string, el: HTMLElement | null) => (() => void) | void;
}

export function ThumbnailStrip({
  pages,
  fullscreenTitle,
  closeLabel,
  onToggle,
  onMove,
  keyboardMoveHint,
  register,
}: ThumbnailStripProps) {
  const [fs, setFs] = useState<number | null>(null);
  const { t } = useTranslation();
  // Pointer-based reorder (v0.9.0 phase 8): HTML5 DnD never fires on touch,
  // so dragging works ONLY from the dedicated grip handle — the strip keeps
  // scrolling normally everywhere else (the safer default against scroll
  // hijacking). Live-move: crossing another cell reorders immediately, the
  // same contract the HTML5 drop path uses.
  const dragRef = useRef<{ fromPage: number; pointerId: number } | null>(null);
  const onHandlePointerDown = (e: React.PointerEvent<HTMLButtonElement>, page: number) => {
    if (!onMove) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { fromPage: page, pointerId: e.pointerId };
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el?.closest?.('[data-page-cell]') as HTMLElement | null;
    const target = Number(cell?.dataset.pageCell);
    if (Number.isFinite(target) && target !== drag.fromPage) onMove?.(drag.fromPage, target);
  };
  const onHandlePointerEnd = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  };
  // Screen-reader announcement for keyboard moves — cells are role=checkbox,
  // which conveys nothing about reordering on its own.
  const [movedAnnouncement, setMovedAnnouncement] = useState<string | null>(null);

  return (
    <>
      <span aria-live="polite" className="sr-only">
        {movedAnnouncement}
      </span>
      {keyboardMoveHint && onMove ? (
        <p className="mb-2 text-[12.5px] text-text-muted">{keyboardMoveHint}</p>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
        {pages.map((p, idx) => (
          <div
            key={p.key}
            ref={register ? (el) => register(p.key, el) : undefined}
            role="checkbox"
            aria-checked={p.selected}
            aria-label={t('a11y.page_n', { n: p.pageNumber })}
            data-page-cell={p.pageNumber}
            tabIndex={0}
            draggable={Boolean(onMove)}
            onClick={() => onToggle(p.pageNumber, idx)}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                onToggle(p.pageNumber, idx);
                return;
              }
              if (keyboardMoveHint && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                // Prevent FIRST: Alt+Arrow is browser Back/Forward — letting the
                // default through at the boundary would navigate off the tool.
                e.preventDefault();
                const target = e.key === 'ArrowLeft' ? idx - 1 : idx + 1;
                if (target < 0 || target >= pages.length) return;
                onMove?.(p.pageNumber, pages[target].pageNumber);
                setMovedAnnouncement(
                  t('a11y.page_moved', { page: p.pageNumber, position: target + 1 }),
                );
              }
            }}
            onDragStart={(e) => e.dataTransfer.setData('text/plain', String(p.pageNumber))}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = Number(e.dataTransfer.getData('text/plain'));
              if (Number.isFinite(from)) onMove?.(from, p.pageNumber);
            }}
            className={`relative cursor-grab rounded-lg border-2 bg-surface-card p-1.5 ${
              p.selected ? 'border-accent' : 'border-border-default hover:border-border-strong'
            }`}
          >
            <span className="absolute top-2.5 left-2.5 rounded-md bg-surface-inverse/85 px-1.75 py-0.5 text-[11px] font-bold text-text-inverse tabular-nums">
              {p.pageNumber}
            </span>
            {onMove ? (
              <>
                <button
                  type="button"
                  aria-label={t('a11y.page_drag_handle', { n: p.pageNumber })}
                  className="absolute top-1.5 left-1/2 grid h-7 w-9 -translate-x-1/2 cursor-grab touch-none place-items-center rounded-md bg-surface-card/80 text-text-muted active:cursor-grabbing"
                  onPointerDown={(e) => onHandlePointerDown(e, p.pageNumber)}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerEnd}
                  onPointerCancel={onHandlePointerEnd}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                    {[
                      [4, 3],
                      [7, 3],
                      [10, 3],
                      [4, 7],
                      [7, 7],
                      [10, 7],
                      [4, 11],
                      [7, 11],
                      [10, 11],
                    ].map(([cx, cy]) => (
                      <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.2" fill="currentColor" />
                    ))}
                  </svg>
                </button>
                <span className="absolute bottom-2.5 left-2.5 flex gap-1">
                  <button
                    type="button"
                    aria-label={t('a11y.page_move_left', { n: p.pageNumber })}
                    className="grid h-7 w-7 place-items-center rounded-md border border-border-strong bg-surface-card text-[13px] text-text-muted disabled:opacity-30"
                    disabled={idx === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (idx > 0) onMove(p.pageNumber, pages[idx - 1]!.pageNumber);
                    }}
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    aria-label={t('a11y.page_move_right', { n: p.pageNumber })}
                    className="grid h-7 w-7 place-items-center rounded-md border border-border-strong bg-surface-card text-[13px] text-text-muted disabled:opacity-30"
                    disabled={idx === pages.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (idx < pages.length - 1) onMove(p.pageNumber, pages[idx + 1]!.pageNumber);
                    }}
                  >
                    →
                  </button>
                </span>
              </>
            ) : null}
            <span
              className={`absolute top-2 right-2 grid h-6 w-6 place-items-center rounded-full border-2 text-[13px] ${
                p.selected ? 'border-accent bg-accent text-text-on-accent' : 'border-border-strong bg-surface-card text-transparent'
              }`}
              aria-hidden
            >
              <CheckIcon size={12} />
            </span>
            {p.url ? (
              <img src={p.url} alt="" className="block aspect-[0.707] w-full rounded border border-border-default object-contain" draggable={false} />
            ) : (
              <span className="block aspect-[0.707] w-full animate-pulse rounded border border-border-default bg-surface-sunken" aria-hidden />
            )}
            <button
              type="button"
              aria-label={fullscreenTitle(p.pageNumber)}
              className="absolute right-2.5 bottom-2.5 hidden h-8 w-8 place-items-center rounded-lg border border-border-strong bg-surface-card text-sm text-text-muted hover:border-accent hover:text-text-primary hover:[display:grid] group-hover:grid"
              onClick={(e) => {
                e.stopPropagation();
                setFs(p.pageNumber);
              }}
            >
              <ExpandIcon size={14} />
            </button>
          </div>
        ))}
      </div>
      <Dialog open={fs !== null} onClose={() => setFs(null)} title={fs !== null ? fullscreenTitle(fs) : ''}>
        {fs !== null && pages[fs - 1]?.url ? (
          <img src={pages[fs - 1].url ?? ''} alt="" className="w-full rounded-lg border border-border-default" />
        ) : (
          <div className="aspect-[0.707] w-full rounded-lg border border-border-default bg-surface-sunken" />
        )}
        <button
          type="button"
          onClick={() => setFs(null)}
          className="mt-3 min-h-9 rounded-lg border border-border-strong px-3.5 text-sm"
        >
          {closeLabel}
        </button>
      </Dialog>
    </>
  );
}

// token-mapped
