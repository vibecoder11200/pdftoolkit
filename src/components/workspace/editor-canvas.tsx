import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { renderPageToCanvas } from '../../engine/pdfjs';
import type { RedactMark } from '../../lib/redact-pipeline';

/*
 * Shared editor page canvases (v0.9.0 phases 3–4): a pdf.js render host plus
 * a pointer overlay (sign-tool's touch-none + setPointerCapture pattern —
 * pointer events fire on touch, HTML5 DnD does not). Items are FRACTIONS of
 * the visible page box, so they survive resizes and render-scale changes.
 *
 * Two interaction models over the same render plumbing:
 *  - EditorCanvas (redact): drag draws a mark, tapping a mark removes it.
 *  - AnnotateCanvas (annotate): drag draws the active element kind, tapping
 *    selects it, dragging it moves it.
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

/** Fits the render to the container width; returns the measured width and a
 * norm() that maps client coords to overlay fractions. Shared by both
 * canvases — not exported (the canvases are the only consumers). */
function usePageCanvas(bytes: Uint8Array, page: number, version: number | string) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const renderGen = useRef(0);

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

  return { wrapRef, canvasRef, overlayRef, width, norm };
}

function CanvasFrame({
  wrapRef,
  canvasRef,
  width,
  children,
  overlayRef,
  disabled,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  testid,
}: {
  wrapRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  width: number;
  children: React.ReactNode;
  overlayRef: React.RefObject<HTMLDivElement | null>;
  disabled: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  testid: string;
}) {
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
          data-testid={testid}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function DraftBox({ draft }: { draft: MarkDraft | null }) {
  if (!draft) return null;
  return (
    <div
      className="pointer-events-none absolute border-2 border-dashed border-red-600/90 bg-red-600/25"
      style={{
        left: `${draft.nx * 100}%`,
        top: `${draft.nyTop * 100}%`,
        width: `${draft.nw * 100}%`,
        height: `${draft.nh * 100}%`,
      }}
    />
  );
}

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
  const { wrapRef, canvasRef, overlayRef, width, norm } = usePageCanvas(bytes, page, version);
  const [draft, setDraft] = useState<MarkDraft | null>(null);
  // Truth mirror of the draft: pointermove coalescing can delay React's
  // commit past pointerup, and a state-read commit would silently drop the
  // mark (caught by the redact e2e as a flaky no-op drag).
  const draftRef = useRef<MarkDraft | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

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
    <CanvasFrame
      wrapRef={wrapRef}
      canvasRef={canvasRef}
      width={width}
      overlayRef={overlayRef}
      disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      testid="editor-overlay"
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
      <DraftBox draft={draft} />
    </CanvasFrame>
  );
}

// ───────────────────────── Annotate canvas (phase 4) ─────────────────────────

export interface AnnotateItem {
  id: string;
  /** 1-based page. */
  page: number;
  /** Fractions of the visible page box, top-left anchor. */
  nx: number;
  nyTop: number;
  nw: number;
  nh: number;
  kind: 'text' | 'rect' | 'line' | 'ellipse';
  /** '#rrggbb'. */
  color: string;
  /** 0..1. */
  opacity: number;
  /** Text font size / shape stroke width, VISUAL pt. */
  size: number;
  /** Shapes: filled vs outline. */
  fill: boolean;
  /** Text content (text kind). */
  text?: string;
}

export function AnnotateCanvas({
  bytes,
  page,
  version,
  items,
  selectedId,
  visualWidth,
  onDraw,
  onItemMove,
  onSelect,
  disabled = false,
}: {
  bytes: Uint8Array;
  page: number;
  version: number | string;
  /** Items of the CURRENT page only. */
  items: AnnotateItem[];
  selectedId: string | null;
  /** VISUAL width in pt — scales text previews to the render. */
  visualWidth: number;
  onDraw: (draft: MarkDraft) => void;
  onItemMove: (id: string, pos: MarkDraft) => void;
  onSelect: (id: string | null) => void;
  disabled?: boolean;
}) {
  const { wrapRef, canvasRef, overlayRef, width, norm } = usePageCanvas(bytes, page, version);
  const [draft, setDraft] = useState<MarkDraft | null>(null);
  const draftRef = useRef<MarkDraft | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  // Move-drag state: which item, where the gesture started, its original box.
  const moveRef = useRef<{
    id: string;
    start: { x: number; y: number };
    orig: MarkDraft;
    moved: boolean;
  } | null>(null);
  const [movePreview, setMovePreview] = useState<MarkDraft | null>(null);

  const setDraftBoth = (d: MarkDraft | null) => {
    draftRef.current = d;
    setDraft(d);
  };

  const beginItemMove = (e: ReactPointerEvent<HTMLDivElement>, item: AnnotateItem) => {
    if (disabled) return;
    e.stopPropagation();
    onSelect(item.id);
    const p = norm(e.clientX, e.clientY);
    // Tap on empty space deselects; a tap on an item keeps it selected.
    moveRef.current = {
      id: item.id,
      start: p,
      orig: { nx: item.nx, nyTop: item.nyTop, nw: item.nw, nh: item.nh },
      moved: false,
    };
    overlayRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    onSelect(null);
    const p = norm(e.clientX, e.clientY);
    startRef.current = p;
    setDraftBoth({ nx: p.x, nyTop: p.y, nw: 0, nh: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = norm(e.clientX, e.clientY);
    if (moveRef.current) {
      const m = moveRef.current;
      const dx = p.x - m.start.x;
      const dy = p.y - m.start.y;
      if (Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002) m.moved = true;
      setMovePreview({
        nx: Math.min(1, Math.max(0, m.orig.nx + dx)),
        nyTop: Math.min(1, Math.max(0, m.orig.nyTop + dy)),
        nw: m.orig.nw,
        nh: m.orig.nh,
      });
      return;
    }
    if (!startRef.current) return;
    const s = startRef.current;
    setDraftBoth({
      nx: Math.min(s.x, p.x),
      nyTop: Math.min(s.y, p.y),
      nw: Math.abs(p.x - s.x),
      nh: Math.abs(p.y - s.y),
    });
  };

  const onPointerUp = () => {
    if (moveRef.current) {
      const m = moveRef.current;
      const preview = movePreview;
      moveRef.current = null;
      setMovePreview(null);
      if (m.moved && preview) onItemMove(m.id, preview);
      return;
    }
    const d = draftRef.current;
    startRef.current = null;
    setDraftBoth(null);
    if (!d || d.nw < MIN_MARK || d.nh < MIN_MARK) return;
    onDraw(d);
  };

  const px = width && visualWidth > 0 ? width / visualWidth : 0;
  const itemStyle = (i: MarkDraft) => ({
    left: `${i.nx * 100}%`,
    top: `${i.nyTop * 100}%`,
    width: `${i.nw * 100}%`,
    height: `${i.nh * 100}%`,
  });

  return (
    <CanvasFrame
      wrapRef={wrapRef}
      canvasRef={canvasRef}
      width={width}
      overlayRef={overlayRef}
      disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      testid="annotate-overlay"
    >
      {items.map((item) => {
        const shown: MarkDraft =
          movePreview && moveRef.current?.id === item.id ? movePreview : item;
        const selected = item.id === selectedId;
        const common = {
          role: 'button' as const,
          tabIndex: 0,
          'aria-label': `annot-${item.kind}-${item.id}`,
          className: `absolute ${
            item.kind === 'line' ? '' : selected ? 'ring-2 ring-accent ring-offset-0' : ''
          }`,
          style: itemStyle(shown),
          onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => beginItemMove(e, item),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSelect(item.id);
            }
          },
        };
        if (item.kind === 'line') {
          return (
            <div key={item.id} {...common} {...(selected ? { style: { ...itemStyle(shown), outline: '2px solid var(--accent, #2563eb)' } } : {})}>
              <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
                <line
                  x1="0"
                  y1="0"
                  x2="100"
                  y2="100"
                  stroke={item.color}
                  strokeWidth={Math.max(1, item.size * px * 0.6)}
                  opacity={item.opacity}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
          );
        }
        if (item.kind === 'text') {
          return (
            <div
              key={item.id}
              {...common}
              className={`absolute cursor-move whitespace-pre ${selected ? 'outline-2 outline-accent' : ''}`}
              style={{
                ...itemStyle(shown),
                height: 'auto',
                minHeight: `${item.nh * 100}%`,
                transform: 'translateY(0)',
                color: item.color,
                fontSize: `${Math.max(6, item.size * px)}px`,
                lineHeight: 1.15,
                opacity: item.opacity,
              }}
            >
              {item.text}
            </div>
          );
        }
        return (
          <div
            key={item.id}
            {...common}
            className={`absolute cursor-move ${selected ? 'ring-2 ring-accent' : ''} ${
              item.kind === 'ellipse' ? 'rounded-[50%]' : ''
            }`}
            style={{
              ...itemStyle(shown),
              backgroundColor: item.fill ? item.color : 'transparent',
              opacity: item.fill ? item.opacity : 1,
              border: item.fill ? 'none' : `${Math.max(1.5, item.size * px)}px solid ${item.color}`,
            }}
          />
        );
      })}
      <DraftBox draft={draft} />
    </CanvasFrame>
  );
}
