import { useState } from 'react';
import { Dialog } from '../ui/dialog';

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
  /** Lazy-render hook: registers each cell so it renders when visible. */
  register?: (key: string, el: HTMLElement | null) => (() => void) | void;
}

export function ThumbnailStrip({
  pages,
  fullscreenTitle,
  closeLabel,
  onToggle,
  onMove,
  register,
}: ThumbnailStripProps) {
  const [fs, setFs] = useState<number | null>(null);

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
        {pages.map((p, idx) => (
          <div
            key={p.key}
            ref={register ? (el) => register(p.key, el) : undefined}
            role="checkbox"
            aria-checked={p.selected}
            aria-label={`Page ${p.pageNumber}`}
            tabIndex={0}
            draggable={Boolean(onMove)}
            onClick={() => onToggle(p.pageNumber, idx)}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                onToggle(p.pageNumber, idx);
              }
            }}
            onDragStart={(e) => e.dataTransfer.setData('text/plain', String(p.pageNumber))}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = Number(e.dataTransfer.getData('text/plain'));
              if (Number.isFinite(from)) onMove?.(from, p.pageNumber);
            }}
            className={`relative cursor-grab rounded-lg border-2 bg-white p-1.5 ${
              p.selected ? 'border-indigo-600' : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <span className="absolute top-2.5 left-2.5 rounded-md bg-slate-900/85 px-1.75 py-0.5 text-[11px] font-bold text-white tabular-nums">
              {p.pageNumber}
            </span>
            <span
              className={`absolute top-2 right-2 grid h-6 w-6 place-items-center rounded-full border-2 text-[13px] ${
                p.selected ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 bg-white text-transparent'
              }`}
              aria-hidden
            >
              ✓
            </span>
            {p.url ? (
              <img src={p.url} alt="" className="block aspect-[0.707] w-full rounded border border-slate-200 object-contain" draggable={false} />
            ) : (
              <span className="block aspect-[0.707] w-full rounded border border-slate-200 bg-gradient-to-b from-white to-slate-100" aria-hidden />
            )}
            <button
              type="button"
              aria-label={`View page ${p.pageNumber} fullscreen`}
              className="absolute right-2.5 bottom-2.5 hidden h-8 w-8 place-items-center rounded-lg border border-slate-300 bg-white text-sm text-slate-500 hover:border-indigo-600 hover:text-slate-900 hover:[display:grid] group-hover:grid"
              onClick={(e) => {
                e.stopPropagation();
                setFs(p.pageNumber);
              }}
            >
              ⛶
            </button>
          </div>
        ))}
      </div>
      <Dialog open={fs !== null} onClose={() => setFs(null)} title={fs !== null ? fullscreenTitle(fs) : ''}>
        {fs !== null && pages[fs - 1]?.url ? (
          <img src={pages[fs - 1].url ?? ''} alt="" className="w-full rounded-lg border border-slate-200" />
        ) : (
          <div className="aspect-[0.707] w-full rounded-lg border border-slate-200 bg-slate-100" />
        )}
        <button
          type="button"
          onClick={() => setFs(null)}
          className="mt-3 min-h-9 rounded-lg border border-slate-300 px-3.5 text-sm"
        >
          {closeLabel}
        </button>
      </Dialog>
    </>
  );
}
