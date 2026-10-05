import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { useThumbnails } from '../../hooks/use-thumbnails';
import { engine } from '../../engine/client';
import { MAX_FILE_BYTES } from '../../lib/file-accept';
import { downloadBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { ThumbnailStrip } from './thumbnail-strip';

type SignTab = 'draw' | 'type' | 'upload';
type SpotMode = 'picked' | 'last';

interface SigImage {
  bytes: Uint8Array;
  url: string;
  width: number;
  height: number;
}

interface Spot {
  id: string;
  page: number;
  /** Center-x as a fraction of page width. */
  nx: number;
  /** Center-y measured from the TOP as a fraction of page height. */
  nyTop: number;
  /** Signature width as a fraction of page width. */
  wFrac: number;
}

interface RunError {
  key: string;
  values?: Record<string, string | number>;
}

let spotUid = 0;

function newSpotId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  spotUid += 1;
  return `sign-spot-${spotUid}`;
}

const PAD_W = 480;
const PAD_H = 200;
const INK = '#1b2a6b';
const DEFAULT_WFRAC = 0.25;
const MIN_WFRAC = 0.08;
const MAX_WFRAC = 0.6;
const PREVIEW_SCALE = 1.0;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPngBytes(head: Uint8Array): boolean {
  if (head.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => head[i] === b);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function outputName(original: string): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'signed';
  return `${base}-signed.pdf`;
}

export function SignTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  const [tab, setTab] = useState<SignTab>('draw');
  const [typedName, setTypedName] = useState('');
  const [drawSig, setDrawSig] = useState<SigImage | null>(null);
  const [typeSig, setTypeSig] = useState<SigImage | null>(null);
  const [uploadSig, setUploadSig] = useState<SigImage | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [defaultWFrac, setDefaultWFrac] = useState(DEFAULT_WFRAC);
  const [spotMode, setSpotMode] = useState<SpotMode>('picked');
  const [digital, setDigital] = useState(false);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<RunError | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';
  const locale = lng === 'vi' ? 'vi-VN' : 'en-US';

  const src = files.length > 0 ? files[0] : null;
  const sig = tab === 'draw' ? drawSig : tab === 'type' ? typeSig : uploadSig;
  const selected = spots.find((s) => s.id === selectedId) ?? null;

  const padRef = useRef<HTMLCanvasElement>(null);
  const pngInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const strokesRef = useRef(0);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    id: string;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    orig: Spot;
  } | null>(null);

  // ---- draw pad setup + snapshot -------------------------------------------
  useEffect(() => {
    const c = padRef.current;
    if (!c) return;
    const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    c.width = PAD_W * dpr;
    c.height = PAD_H * dpr;
  }, []);

  const snapshotPad = () => {
    const c = padRef.current;
    if (!c) return;
    if (strokesRef.current === 0) {
      setDrawSig((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return null;
      });
      return;
    }
    c.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      void blob.arrayBuffer().then((buf) => {
        setDrawSig((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return { bytes: new Uint8Array(buf), url, width: c.width, height: c.height };
        });
      });
    }, 'image/png');
  };

  const padPoint = (clientX: number, clientY: number) => {
    const c = padRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / Math.max(1, r.width)) * c.width,
      y: ((clientY - r.top) / Math.max(1, r.height)) * c.height,
    };
  };

  const clearPad = () => {
    const c = padRef.current;
    const ctx = c?.getContext('2d');
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    strokesRef.current = 0;
    setDrawSig((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  // ---- typed name -> signature PNG (rendered as an image; no PDF text) -----
  useEffect(() => {
    let cancelled = false;
    const name = typedName.trim();
    if (!name) {
      setTypeSig((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return null;
      });
      return;
    }
    const font = '96px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive';
    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) return;
    measure.font = font;
    const c = document.createElement('canvas');
    c.width = Math.max(8, Math.ceil(measure.measureText(name).width) + 48);
    c.height = 160;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.font = font;
    ctx.fillStyle = INK;
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 24, 86);
    c.toBlob((blob) => {
      if (cancelled || !blob) return;
      const url = URL.createObjectURL(blob);
      void blob.arrayBuffer().then((buf) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setTypeSig((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return { bytes: new Uint8Array(buf), url, width: c.width, height: c.height };
        });
      });
    }, 'image/png');
    return () => {
      cancelled = true;
    };
  }, [typedName]);

  // ---- PNG upload (magic-byte validated, never trusts MIME) ----------------
  const onPngSelected = async (list: File[]) => {
    const f = list[0];
    if (!f) return;
    setRunError(null);
    if (f.size > MAX_FILE_BYTES) {
      setRunError({ key: 'sign.err_too_large', values: { name: f.name } });
      return;
    }
    const head = new Uint8Array(await f.slice(0, 8).arrayBuffer());
    if (!isPngBytes(head)) {
      setRunError({ key: 'sign.err_not_png', values: { name: f.name } });
      return;
    }
    const raw = await f.arrayBuffer();
    try {
      const bmp = await createImageBitmap(new Blob([raw], { type: 'image/png' }));
      const w = bmp.width;
      const h = bmp.height;
      bmp.close();
      if (w === 0 || h === 0) throw new Error('empty image');
      const url = URL.createObjectURL(new Blob([raw], { type: 'image/png' }));
      setUploadSig((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { bytes: new Uint8Array(raw), url, width: w, height: h };
      });
    } catch {
      setRunError({ key: 'sign.err_not_png', values: { name: f.name } });
    }
  };

  // ---- PDF info + thumbnails + main preview --------------------------------
  useEffect(() => {
    let cancelled = false;
    setNumPages(0);
    setCurrentPage(1);
    setSpots([]);
    setSelectedId(null);
    if (!src) return;
    void (async () => {
      try {
        const { info } = await engine.loadPdf(src.bytes);
        if (cancelled) return;
        setNumPages(info.numPages);
      } catch (e) {
        if (cancelled) return;
        setRunError({
          key: 'sign.err_failed',
          values: { message: e instanceof Error ? e.message : String(e) },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  // ---- thumbnails (lazy viewport) + main preview ---------------------------
  const thumbJobs =
    src && numPages > 0
      ? Array.from({ length: numPages }, (_, i) => ({
          id: `p${i + 1}`,
          bytes: src.bytes,
          page: i + 1,
          version: 0,
        }))
      : [];
  const { urlFor, observe } = useThumbnails(thumbJobs);

  useEffect(() => {
    let cancelled = false;
    if (!src || numPages === 0) return;
    void (async () => {
      const { renderPageToCanvas } = await import('../../engine/pdfjs');
      if (cancelled) return;
      const canvas = previewCanvasRef.current;
      if (!canvas) return;
      try {
        await renderPageToCanvas(src.bytes, currentPage, canvas, PREVIEW_SCALE);
      } catch (e) {
        if (cancelled) return;
        setRunError({
          key: 'sign.err_failed',
          values: { message: e instanceof Error ? e.message : String(e) },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, numPages, currentPage]);

  // ---- spots ----------------------------------------------------------------
  const addSpotAt = (relX: number, relYTop: number) => {
    if (!sig) {
      setRunError({ key: 'sign.err_no_signature' });
      return;
    }
    if (spotMode !== 'picked') return;
    const spot: Spot = {
      id: newSpotId(),
      page: currentPage,
      nx: clamp01(relX),
      nyTop: clamp01(relYTop),
      wFrac: selected?.wFrac ?? defaultWFrac,
    };
    setSpots((prev) => [...prev, spot]);
    setSelectedId(spot.id);
    setRunError(null);
  };

  const removeSpot = (id: string) => {
    setSpots((prev) => prev.filter((s) => s.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  };

  const onSpotPointerMove = (clientX: number, clientY: number) => {
    const d = dragRef.current;
    if (!d) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const dx = (clientX - d.startX) / r.width;
    const dy = (clientY - d.startY) / r.height;
    setSpots((prev) =>
      prev.map((s) => {
        if (s.id !== d.id) return s;
        if (d.mode === 'resize') {
          return {
            ...s,
            wFrac: Math.min(MAX_WFRAC, Math.max(MIN_WFRAC, d.orig.wFrac + dx)),
          };
        }
        return { ...s, nx: clamp01(d.orig.nx + dx), nyTop: clamp01(d.orig.nyTop + dy) };
      }),
    );
  };

  const endSpotDrag = () => {
    dragRef.current = null;
  };

  // ---- run: embedPng + drawImage --------------------------------------------
  const run = async () => {
    setRunError(null);
    setSucceeded(false);
    if (!src) {
      setRunError({ key: 'sign.err_no_file' });
      return;
    }
    if (!sig && !digital) {
      setRunError({ key: 'sign.err_no_signature' });
      return;
    }
    if (sig && spotMode === 'picked' && spots.length === 0) {
      setRunError({ key: 'sign.err_no_spot' });
      return;
    }
    setBusy(true);
    try {
      setProgress({ value: 15, label: t('sign.progress_working') });
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.load(src.bytes.slice());
      if (sig) {
        const embedded = await doc.embedPng(sig.bytes);
        const iw = embedded.width;
        const ih = embedded.height;
        const placeOn = (pageNum: number, nxC: number, nyTopC: number, wFrac: number) => {
          const page = doc.getPage(pageNum - 1);
          const { width: pw, height: ph } = page.getSize();
          let w = Math.min(Math.max(wFrac, MIN_WFRAC), MAX_WFRAC) * pw;
          let h = (w * ih) / iw;
          if (h > ph * 0.9) {
            h = ph * 0.9;
            w = (h * iw) / ih;
          }
          const x = Math.min(Math.max(nxC * pw - w / 2, 0), Math.max(0, pw - w));
          const y = Math.min(Math.max((1 - nyTopC) * ph - h / 2, 0), Math.max(0, ph - h));
          page.drawImage(embedded, { x, y, width: w, height: h });
        };
        if (spotMode === 'last') {
          const last = doc.getPageCount();
          const pg = doc.getPage(last - 1);
          const { width: pw, height: ph } = pg.getSize();
          let w = DEFAULT_WFRAC * pw;
          let h = (w * ih) / iw;
          if (h > ph * 0.9) {
            h = ph * 0.9;
            w = (h * iw) / ih;
          }
          pg.drawImage(embedded, { x: pw - w - 36, y: 36, width: w, height: h });
        } else {
          spots.forEach((s, i) => {
            setProgress({
              value: 15 + Math.round((70 * i) / Math.max(1, spots.length)),
              label: t('sign.progress_working'),
            });
            placeOn(s.page, s.nx, s.nyTop, s.wFrac);
          });
        }
      }
      setProgress({ value: 85, label: t('sign.progress_working') });
      let out: Uint8Array;
      if (digital) {
        const { addSelfSignature } = await import('../../lib/sign');
        try {
          out = await addSelfSignature(doc);
        } catch (e) {
          if (e instanceof Error && e.message === 'already-signed') {
            setRunError({ key: 'sign.err_already_signed' });
            setProgress(null);
            return;
          }
          throw e;
        }
      } else {
        out = await doc.save();
      }
      setProgress({ value: 100, label: t('sign.progress_done') });
      downloadBytes(out, outputName(src.file.name));
      setSucceeded(true);
    } catch (e) {
      setRunError({
        key: 'sign.err_failed',
        values: { message: e instanceof Error ? e.message : String(e) },
      });
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const resetAll = () => {
    clear();
    setSpots([]);
    setSelectedId(null);
    setCurrentPage(1);
    setSpotMode('picked');
    setDigital(false);
    setProgress(null);
    setRunError(null);
    setSucceeded(false);
  };

  const fileErrorParts = (() => {
    if (!fileError) return null;
    const idx = fileError.indexOf(':');
    const code = idx === -1 ? fileError : fileError.slice(0, idx);
    const name = idx === -1 ? '' : fileError.slice(idx + 1);
    if (code === 'too-large') return { key: 'sign.err_too_large', values: { name } };
    if (code === 'not-pdf') return { key: 'sign.err_not_pdf', values: { name } };
    if (code === 'heic-refused') return { key: 'sign.err_heic', values: { name } };
    return null;
  })();

  const error = fileErrorParts
    ? t(fileErrorParts.key, fileErrorParts.values)
    : runError
      ? t(runError.key, runError.values)
      : null;

  const currentSpots = spots.filter((s) => s.page === currentPage);
  const sizePct = Math.round(((selected?.wFrac ?? defaultWFrac) * 100));

  return (
    <WorkspaceShell
      title={t('sign.title')}
      meta={
        src
          ? lng === 'vi'
            ? `${src.file.name} · ${numPages} trang · ${formatBytes(src.file.size, 'vi-VN')}`
            : `${src.file.name} · ${numPages} pages · ${formatBytes(src.file.size, 'en-US')}`
          : undefined
      }
      steps={[
        { label: '1', state: src ? 'done' : 'now' },
        { label: '2', state: succeeded ? 'done' : src ? 'now' : 'todo' },
        { label: '3', state: succeeded ? 'now' : 'todo' },
      ]}
      error={error}
      side={
        <>
          <Button onClick={() => void run()} disabled={!src || (!sig && !digital) || busy}>
            {t('sign.cta')}
          </Button>
          {progress ? null : (
            <span className="text-[13px] text-slate-500">{t('sign.progress_idle')}</span>
          )}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={digital}
              onChange={(e) => setDigital(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-indigo-600"
            />
            <span>
              <span className="block font-semibold">{t('sign.digital_label')}</span>
              <span className="block text-[13px] text-slate-500">{t('sign.digital_hint')}</span>
            </span>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-bold text-slate-900">{t('sign.size_label')}</span>
            <input
              type="range"
              min={Math.round(MIN_WFRAC * 100)}
              max={Math.round(MAX_WFRAC * 100)}
              step={1}
              value={sizePct}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                if (selected) {
                  setSpots((prev) =>
                    prev.map((s) => (s.id === selected.id ? { ...s, wFrac: v } : s)),
                  );
                } else {
                  setDefaultWFrac(v);
                }
              }}
              className="w-full accent-indigo-600"
            />
            <span className="text-[13px] text-slate-500">{t('sign.size_value', { pct: sizePct })}</span>
          </label>
        </>
      }
      progress={progress}
      onReset={resetAll}
    >
      <div className="flex gap-2" role="tablist" aria-label={t('sign.title')}>
        {(['draw', 'type', 'upload'] as SignTab[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={tab === m}
            onClick={() => setTab(m)}
            className={`inline-flex min-h-10 flex-1 items-center justify-center rounded-lg border px-4 text-sm font-semibold ${
              tab === m
                ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t(m === 'draw' ? 'sign.tab_draw' : m === 'type' ? 'sign.tab_type' : 'sign.tab_upload')}
          </button>
        ))}
      </div>

      {tab === 'draw' ? (
        <div className="mt-3">
          <p className="text-[13px] text-slate-500">{t('sign.pad_hint')}</p>
          <canvas
            ref={padRef}
            className="mt-2 block aspect-[12/5] w-full cursor-crosshair touch-none rounded-lg border border-slate-300 bg-white"
            onPointerDown={(e) => {
              drawingRef.current = true;
              lastRef.current = padPoint(e.clientX, e.clientY);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drawingRef.current) return;
              const c = padRef.current;
              const ctx = c?.getContext('2d');
              const last = lastRef.current;
              if (!c || !ctx || !last) return;
              const p = padPoint(e.clientX, e.clientY);
              ctx.strokeStyle = INK;
              ctx.lineWidth = Math.max(2, (c.width / PAD_W) * 2.5);
              ctx.lineCap = 'round';
              ctx.lineJoin = 'round';
              ctx.beginPath();
              ctx.moveTo(last.x, last.y);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
              lastRef.current = p;
              strokesRef.current += 1;
            }}
            onPointerUp={() => {
              drawingRef.current = false;
              lastRef.current = null;
              snapshotPad();
            }}
            onPointerLeave={() => {
              if (drawingRef.current) {
                drawingRef.current = false;
                lastRef.current = null;
                snapshotPad();
              }
            }}
          />
          <div className="mt-2">
            <Button variant="secondary" size="sm" onClick={clearPad}>
              {t('sign.clear')}
            </Button>
          </div>
        </div>
      ) : null}

      {tab === 'type' ? (
        <label className="mt-3 block text-sm">
          <span className="mb-1 block font-bold">{t('sign.type_label')}</span>
          <input
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            placeholder={t('sign.type_placeholder')}
            className="min-h-11 w-full rounded-lg border border-slate-300 px-3.5 text-sm"
            style={{ fontFamily: '"Segoe Script", "Brush Script MT", "Snell Roundhand", cursive' }}
          />
        </label>
      ) : null}

      {tab === 'upload' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <Button variant="secondary" onClick={() => pngInputRef.current?.click()}>
            {t('sign.upload_cta')}
          </Button>
          <span className="text-[13px] text-slate-500">{t('sign.upload_hint')}</span>
          <input
            ref={pngInputRef}
            type="file"
            accept="image/png,.png"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onPngSelected([f]);
            }}
          />
        </div>
      ) : null}

      {sig ? (
        <div className="mt-2.5 flex items-center gap-2.5">
          <img
            src={sig.url}
            alt=""
            className="h-12 max-w-44 rounded border border-slate-200 bg-white object-contain"
          />
        </div>
      ) : null}

      <div className="mt-3.5">
        <Dropzone
          title={t('sign.dropzone_title')}
          hint={t('sign.dropzone_hint')}
          accept="application/pdf,.pdf"
          multiple={false}
          onFiles={(f) => {
            if (f.length === 0) return;
            clear();
            setProgress(null);
            setRunError(null);
            setSucceeded(false);
            void add([f[0]]);
          }}
        />
      </div>

      {src ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-slate-200 p-2.5 text-[13.5px]">
          <span>📄</span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{src.file.name}</span>
          <span className="ml-auto text-xs whitespace-nowrap text-slate-500 tabular-nums">
            {formatBytes(src.file.size, locale)} · {numPages} {lng === 'vi' ? 'trang' : 'pages'}
          </span>
        </div>
      ) : null}

      <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-[13.5px]" role="note">
        <strong className="block text-amber-900">{t('sign.disclaimer_title')}</strong>
        <span className="block text-amber-900">{t('sign.disclaimer')}</span>
        <span className="mt-1.5 block text-amber-900">{t('sign.single_note')}</span>
        <span className="mt-1.5 block text-amber-900">{t('sign.scope_note')}</span>
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-bold">{t('sign.position_q')}</legend>
        <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label={t('sign.position_q')}>
          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
              spotMode === 'picked' ? 'border-indigo-600 bg-white' : 'border-slate-300 bg-white'
            }`}
          >
            <input
              type="radio"
              name="sign-pos"
              value="picked"
              checked={spotMode === 'picked'}
              onChange={() => setSpotMode('picked')}
              className="mt-1 h-4 w-4 accent-indigo-600"
            />
            <span>
              <span className="block font-semibold">{t('sign.position_picked', { n: currentPage })}</span>
              <span className="block text-[13px] text-slate-500">{t('sign.position_picked_hint')}</span>
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
              spotMode === 'last' ? 'border-indigo-600 bg-white' : 'border-slate-300 bg-white'
            }`}
          >
            <input
              type="radio"
              name="sign-pos"
              value="last"
              checked={spotMode === 'last'}
              onChange={() => setSpotMode('last')}
              className="mt-1 h-4 w-4 accent-indigo-600"
            />
            <span>
              <span className="block font-semibold">{t('sign.position_last')}</span>
              <span className="block text-[13px] text-slate-500">{t('sign.position_last_hint')}</span>
            </span>
          </label>
        </div>
      </fieldset>

      {src && numPages > 0 ? (
        <>
          <div className="mt-4 flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
            >
              {t('sign.page_prev')}
            </Button>
            <span className="text-[13px] text-slate-500 tabular-nums">
              {t('sign.page_of', { n: currentPage, total: numPages })}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
              disabled={currentPage >= numPages}
            >
              {t('sign.page_next')}
            </Button>
          </div>
          <p className="mt-2 text-[13px] text-slate-500">
            {t('sign.preview_hint')} · {t('sign.preview_resize')}
          </p>
          <div
            ref={wrapRef}
            className="relative mt-2 overflow-hidden rounded-lg border border-slate-200 bg-slate-100"
          >
            <canvas
              ref={previewCanvasRef}
              className="block h-auto w-full cursor-crosshair"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return;
                addSpotAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
              }}
            />
            {sig
              ? currentSpots.map((s) => (
                  <div
                    key={s.id}
                    role="button"
                    tabIndex={0}
                    aria-label={t('sign.spot_label', { n: s.page })}
                    title={t('sign.preview_placed', { n: s.page })}
                    className={`absolute touch-none ${
                      s.id === selectedId ? 'ring-2 ring-indigo-600' : 'ring-1 ring-slate-900/40'
                    }`}
                    style={{
                      left: `${s.nx * 100}%`,
                      top: `${s.nyTop * 100}%`,
                      width: `${s.wFrac * 100}%`,
                      aspectRatio: `${sig.width} / ${sig.height}`,
                      transform: 'translate(-50%, -50%)',
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId(s.id);
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedId(s.id);
                      e.currentTarget.setPointerCapture(e.pointerId);
                      dragRef.current = {
                        id: s.id,
                        mode: 'move',
                        startX: e.clientX,
                        startY: e.clientY,
                        orig: s,
                      };
                    }}
                    onPointerMove={(e) => onSpotPointerMove(e.clientX, e.clientY)}
                    onPointerUp={endSpotDrag}
                    onKeyDown={(e) => {
                      if (e.key === 'Delete' || e.key === 'Backspace') {
                        e.preventDefault();
                        removeSpot(s.id);
                      }
                    }}
                  >
                    <img src={sig.url} alt="" className="h-full w-full" draggable={false} />
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={t('sign.spot_remove', { n: s.page })}
                      className="absolute -right-2 -bottom-2 grid h-6 w-6 cursor-nwse-resize place-items-center rounded-full border border-indigo-600 bg-white text-[12px] text-indigo-700"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSelectedId(s.id);
                        e.currentTarget.setPointerCapture(e.pointerId);
                        dragRef.current = {
                          id: s.id,
                          mode: 'resize',
                          startX: e.clientX,
                          startY: e.clientY,
                          orig: s,
                        };
                      }}
                      onPointerMove={(e) => onSpotPointerMove(e.clientX, e.clientY)}
                      onPointerUp={endSpotDrag}
                      onClick={(e) => e.stopPropagation()}
                    >
                      ⇲
                    </span>
                  </div>
                ))
              : null}
          </div>
          {spots.length > 0 ? (
            <div className="mt-3">
              <p className="text-sm font-bold">{t('sign.spots_title', { count: spots.length })}</p>
              <ul className="mt-2 flex flex-col gap-2">
                {[...spots]
                  .sort((a, b) => a.page - b.page)
                  .map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center gap-2.5 rounded-lg border border-slate-200 p-2.5 text-[13.5px]"
                    >
                      <button
                        type="button"
                        className="font-semibold text-indigo-700 hover:underline"
                        onClick={() => {
                          setCurrentPage(s.page);
                          setSelectedId(s.id);
                        }}
                      >
                        {t('sign.spot_label', { n: s.page })}
                      </button>
                      <span className="ml-auto text-xs text-slate-500 tabular-nums">
                        {Math.round(s.wFrac * 100)}%
                      </span>
                      <button
                        type="button"
                        aria-label={t('sign.spot_remove', { n: s.page })}
                        className="min-h-10 min-w-10 text-slate-500 hover:text-red-600"
                        onClick={() => removeSpot(s.id)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-3.5 mb-2.5 text-[13px] text-slate-500">
            {t('sign.page_of', { n: currentPage, total: numPages })}
          </div>
          <ThumbnailStrip
            pages={Array.from({ length: numPages }, (_, i) => ({
              key: `p${i + 1}`,
              pageNumber: i + 1,
              url: urlFor(`p${i + 1}`),
              selected: spots.some((s) => s.page === i + 1),
            }))}
            fullscreenTitle={(n) => t('sign.fs_title', { n })}
            closeLabel={t('sign.fs_close')}
            register={observe}
            onToggle={(pageNumber: number) => setCurrentPage(pageNumber)}
          />
        </>
      ) : null}
    </WorkspaceShell>
  );
}
