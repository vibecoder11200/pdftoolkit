import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { renderPageToCanvas } from '../../engine/pdfjs';
import type { RedactMark } from '../../lib/redact-pipeline';

/*
 * Shared editor page canvas (v0.9.0 phase 3): pdf.js render host + a pointer
 * overlay for box drawing (sign-tool's touch-none + setPointerCapture pattern
 * — pointer events fire on touch, HTML5 DnD does not). Marks are FRACTIONS of
 * the visible page box, so they survive resizes and render-scale changes.
 * Tapping an existing mark removes it; dragging on empty page draws a new one.
 */

export interface MarkDraft {
  nx: number;
  nyTop: number;
  nw: number;
  nh: number;
}

let markSeq = 0;
export function newMarkId(): string {
  markSeq += 1;
  return `m${markSeq}`;
}

const MIN_MARK = 0.012; // ignore accidental taps below ~1.2% of the page

export function EditorCanvas({
  bytes,
  page,
  version,
  marks,
  onAdd,
  onRemove,
  disabled = false,
}: {
  bytes: Uint8Array;
  page: number;
  version: number | string;
  marks: RedactMark[];
  onAdd: (mark: Omit<RedactMark, 'id' | 'page'>) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [draft, setDraft] = useState<MarkDraft | null>(null);
  // Truth mirror of the draft: pointermove coalescing can delay React's
  // commit past pointerup, and a state-read commit would silently drop the
  // mark (caught by the redact e2e as a flaky no-op drag).
  const draftRef = useRef<MarkDraft | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const renderGen = useRef(0);

  // Fit the render to the container width (re-rendered on resize).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const gen = (renderGen.current += 1);
    const canvas = canvasRef.current;
    if (!canvas || width < 40) return;
    let cancelled = false;
    void (async () => {
      try {
        // Two-step fit: render once at a probe scale to learn the visual box,
        // then the container width decides the final scale. getPageVisualSize
        // is a cheap cached-doc call, so ask it directly.
        const { getPageVisualSize } = await import('../../engine/pdfjs');
        const size = await getPageVisualSize(bytes, page);
        if (cancelled || renderGen.current !== gen) return;
        const scale = Math.min(2.5, Math.max(0.2, width / size.width));
        await renderPageToCanvas(bytes, page, canvas, scale);
      } catch {
        /* placeholder frame stays */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, page, version, width]);

  const norm = (clientX: number, clientY: number) => {
    const el = overlayRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
    };
  };

  const setDraftBoth = (d: MarkDraft | null) => {
    draftRef.current = d;
    setDraft(d);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const p = norm(e.clientX, e.clientY);
    startRef.current = p;
    setDraftBoth({ nx: p.x, nyTop: p.y, nw: 0, nh: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const p = norm(e.clientX, e.clientY);
    const s = startRef.current;
    setDraftBoth({
      nx: Math.min(s.x, p.x),
      nyTop: Math.min(s.y, p.y),
      nw: Math.abs(p.x - s.x),
      nh: Math.abs(p.y - s.y),
    });
  };

  const onPointerUp = () => {
    const d = draftRef.current;
    startRef.current = null;
    setDraftBoth(null);
    if (!d || d.nw < MIN_MARK || d.nh < MIN_MARK) return;
    onAdd({ nx: d.nx, nyTop: d.nyTop, nw: d.nw, nh: d.nh });
  };

  return (
    <div ref={wrapRef} className="w-full">
      <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-lg border border-border-strong bg-white shadow-sm">
        <canvas ref={canvasRef} className="block max-w-full" style={{ width: width ? `${width}px` : undefined }} />
        <div
          ref={overlayRef}
          className={`absolute inset-0 ${disabled ? '' : 'touch-none cursor-crosshair'}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          data-testid="editor-overlay"
        >
          {marks.map((m) => (
            <div
              key={m.id}
              role="button"
              tabIndex={0}
              aria-label={`mark-${m.id}`}
              title="×"
              className="absolute cursor-pointer border-2 border-red-600/90 bg-red-600/45"
              style={{
                left: `${m.nx * 100}%`,
                top: `${m.nyTop * 100}%`,
                width: `${m.nw * 100}%`,
                height: `${m.nh * 100}%`,
              }}
              onPointerDown={(e) => {
                if (disabled) return;
                e.stopPropagation();
                onRemove(m.id);
              }}
              onKeyDown={(e) => {
                if (disabled) return;
                if (e.key === 'Delete' || e.key === 'Enter') {
                  e.preventDefault();
                  onRemove(m.id);
                }
              }}
            />
          ))}
          {draft ? (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-red-600/90 bg-red-600/25"
              style={{
                left: `${draft.nx * 100}%`,
                top: `${draft.nyTop * 100}%`,
                width: `${draft.nw * 100}%`,
                height: `${draft.nh * 100}%`,
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
