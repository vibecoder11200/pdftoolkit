import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OrganizeCommand, OrganizeManifest, PageInstance } from '../../lib/organize-model';
import {
  canRedo,
  canUndo,
  createHistory,
  pushCommand,
  redo,
  undo,
  wouldDiscardOnPush,
} from '../../lib/organize-history';
import { engine } from '../../engine/client';
import { renderPageToCanvas } from '../../engine/pdfjs';
import { deliverBytes } from '../../lib/download';
import { engineErrorDetail } from '../../lib/engine-error';
import { Dropzone } from '../ui/dropzone';
import { Button } from '../ui/button';
import { WorkspaceShell } from './workspace-shell';
import { checkPdfFile } from '../../lib/file-accept';
import { OrganizeBookmarksPanel, type OrganizeBookmarkUiNode } from './organize-bookmarks';
import { analyzeInk, blankRasterScale, classifyBlank, type BlankVerdict } from '../../lib/blank-page';

interface SourceDoc {
  sourceId: string;
  name: string;
  bytes: Uint8Array;
  pageCount: number;
}

let sourceCounter = 0;

export function OrganizeTool() {
  const { t } = useTranslation('common');
  const [sources, setSources] = useState<SourceDoc[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<{ detail: string; onRetry?: () => void } | null>(null);
  void runError?.onRetry;
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [historyState, setHistoryState] = useState(() =>
    createHistory({ instances: [] } satisfies OrganizeManifest),
  );
  const manifest = historyState.current;
  const [bookmarks, setBookmarks] = useState<OrganizeBookmarkUiNode[]>([]);
  const [bookmarkPast, setBookmarkPast] = useState<OrganizeBookmarkUiNode[][]>([]);
  const [bookmarkFuture, setBookmarkFuture] = useState<OrganizeBookmarkUiNode[][]>([]);
  const sourcesRef = useRef<SourceDoc[]>([]);
  sourcesRef.current = sources;

  /** Multi-PDF intake: every source registers; ALL its pages join the
   * manifest in order. */
  const addFiles = useCallback(
    async (files: File[]) => {
      setLoadError(null);
      const added: SourceDoc[] = [];
      for (const f of files) {
        try {
          const verdict = await checkPdfFile(f);
          if (!verdict.ok) {
            setLoadError(t('organize.err_file', { name: f.name }));
            continue;
          }
          const bytes = new Uint8Array(await f.arrayBuffer());
          const info = await engine.loadPdf(bytes);
          sourceCounter += 1;
          added.push({
            sourceId: `s${sourceCounter}`,
            name: f.name,
            bytes,
            pageCount: info.info.numPages,
          });
        } catch (e) {
          setLoadError(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (added.length === 0) return;
      setSources((prev) => [...prev, ...added]);
      // Every page of every added source joins the manifest.
      for (const src of added) {
        setHistoryState((h) =>
          pushCommand(h, {
            type: 'insertSource',
            afterInstanceId: h.current.instances.at(-1)?.instanceId ?? null,
            sourceId: src.sourceId,
            sourcePages: Array.from({ length: src.pageCount }, (_, i) => i + 1),
          }),
        );
      }
    },
    [t],
  );

  const dispatch = useCallback((cmd: OrganizeCommand) => {
    setRunError(null);
    // Budget guard: ask BEFORE discarding undo history (never silent).
    setHistoryState((h) => {
      if (wouldDiscardOnPush(h)) {
        const ok = window.confirm(t('organize.history_full'));
        if (!ok) return h;
      }
      return pushCommand(h, cmd);
    });
  }, []);

  const sel = (ids: string[] | 'all' | 'none') =>
    setSelected((prev) => {
      if (ids === 'all') return new Set(manifest.instances.map((p) => p.instanceId));
      if (ids === 'none') return new Set();
      const next = new Set(prev);
      for (const id of ids) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const selectedIds = manifest.instances
    .filter((p) => selected.has(p.instanceId))
    .map((p) => p.instanceId);

  const move = (id: string, targetId: string) => {
    if (id === targetId) return;
    const order = manifest.instances.map((p) => p.instanceId);
    const from = order.indexOf(id);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, ...order.splice(from, 1));
    dispatch({ type: 'reorder', order });
  };

  const moveBy = (id: string, delta: number) => {
    const order = manifest.instances.map((p) => p.instanceId);
    const from = order.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, ...order.splice(from, 1));
    dispatch({ type: 'reorder', order });
  };

  const insertBlankAfter = (anchor: string | null) => {
    const first = manifest.instances[0];
    dispatch({
      type: 'insertBlank',
      afterInstanceId: anchor,
      count: 1,
      // A4 portrait default; the blank spec IS the size/orientation choice.
      spec: first?.blank ?? { widthPt: 595, heightPt: 842 },
    });
  };

  const insertPdfFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf';
    input.multiple = true;
    input.onchange = () => void addFiles(Array.from(input.files ?? []));
    input.click();
  };

  /** Composed export: ONE engine call for the whole manifest. Extraction is
   * the same composer restricted to the selected instances (additional
   * artifact through the report contract). */
  const exportPdf = useCallback(
    async (only: string[] | null) => {
      if (manifest.instances.length === 0) return;
      if (only && only.length === 0) return;
      setBusy(true);
      setRunError(null);
      setProgress({ value: 10, label: t('organize.progress_export') });
      try {
        const plans = (only ? manifest.instances.filter((p) => only.includes(p.instanceId)) : manifest.instances).map(
          (p): import('../../engine/pdf-lib').OrganizePagePlan =>
            p.blank
              ? { kind: 'blank', widthPt: p.blank.widthPt, heightPt: p.blank.heightPt, rotation: p.rotation }
              : {
                  kind: 'source',
                  source: sourcesRef.current.findIndex((s) => s.sourceId === p.sourceId),
                  page: p.sourcePage ?? 1,
                  rotation: p.rotation,
                },
        );
        // Bookmarks bind to instance ids; map to OUTPUT positions (only
        // when exporting everything). Extracted subsets drop bookmark
        // targets inside the selection and REPORT the others (never stale).
        const bmWrites: import('../../engine/pdf-lib').OrganizeBookmarkWrite[] = [];
        if (!only) {
          const posOf = new Map<string, number>();
          manifest.instances.forEach((p, i) => posOf.set(p.instanceId, i + 1));
          const toWrite = (nodes: OrganizeBookmarkUiNode[]): import('../../engine/pdf-lib').OrganizeBookmarkWrite[] =>
            nodes.map((n) => ({
              title: n.title,
              destPage: n.targetInstanceId ? posOf.get(n.targetInstanceId) : undefined,
              children: toWrite(n.children),
            }));
          bmWrites.push(...toWrite(bookmarks));
        }
        setProgress({ value: 45, label: t('organize.progress_export') });
        const { bytes, report } = await engine.organizeExport(
          sourcesRef.current.map((s) => s.bytes),
          plans,
          bmWrites,
        );
        setProgress({ value: 90, label: t('organize.progress_export') });
        const stem = sourcesRef.current[0]?.name?.replace(/\.pdf$/i, '') ?? 'document';
        const saved = await deliverBytes(bytes, `${stem}-${t('organize.out_suffix')}.pdf`, 'download');
        if (!saved) {
          setProgress(null); // picker cancelled — not an error
          return;
        }
        setProgress({ value: 100, label: t('organize.progress_done') });
        // Surface the composer's integrity report honestly.
        const notes: string[] = [];
        if (Object.keys(report.fieldRenames).length > 0) {
          notes.push(t('organize.note_renames', { n: Object.keys(report.fieldRenames).length }));
        }
        if (report.unresolvedDests.length > 0) {
          notes.push(t('organize.note_unresolved', { n: report.unresolvedDests.length }));
        }
        if (report.droppedLinks > 0) notes.push(t('organize.note_links', { n: report.droppedLinks }));
        if (report.unresolvedBookmarks.length > 0) {
          notes.push(t('organize.note_bookmarks', { n: report.unresolvedBookmarks.length }));
        }
        setExportNotes(notes);
      } catch (e) {
        const d = engineErrorDetail(
          e,
          t('organize.err_export'),
          { title: t('organize.err_crash_title'), detail: t('organize.err_crash') },
          () => void exportPdf(only),
        );
        setRunError({ detail: typeof d === 'string' ? d : String(d.detail) });
        setProgress(null);
      } finally {
        setBusy(false);
      }
    },
    [manifest, bookmarks, t],
  );
  const [exportNotes, setExportNotes] = useState<string[]>([]);
  const [blankVerdicts, setBlankVerdicts] = useState<Map<string, BlankVerdict>>(new Map());
  const [scanning, setScanning] = useState(false);

  /** Blank-page review (existing classifier): rasterize each SOURCE-bound
   * instance at BLANK_DPI and badge blank/near/unknown. NEVER auto-deletes
   * (unknown is never actionable) — the user removes badges explicitly. */
  const scanBlanks = useCallback(async () => {
    setScanning(true);
    setRunError(null);
    try {
      const next = new Map<string, BlankVerdict>();
      for (const inst of manifest.instances) {
        if (!inst.sourceId) continue; // blanks are blank by construction
        const src = sourcesRef.current.find((sd) => sd.sourceId === inst.sourceId);
        if (!src) continue;
        const scale = blankRasterScale(595, 842).scale;
        const canvas = document.createElement('canvas');
        await renderPageToCanvas(src.bytes, inst.sourcePage ?? 1, canvas, scale);
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) continue;
        const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
        const stats = analyzeInk(img);
        next.set(inst.instanceId, classifyBlank(stats, blankRasterScale(canvas.width, canvas.height).clamped));
      }
      setBlankVerdicts(next);
    } finally {
      setScanning(false);
    }
  }, [manifest.instances]);

  // Keyboard reorder/rotate on the focused tile (a11y requirement).
  const onKeyDownTile = (e: React.KeyboardEvent, inst: PageInstance, idx: number) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveBy(inst.instanceId, -1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveBy(inst.instanceId, 1); }
    else if (e.key === 'r') dispatch({ type: 'rotate', instanceIds: [inst.instanceId], delta: 90 });
    else if (e.key === 'Delete' || e.key === 'Backspace') dispatch({ type: 'delete', instanceIds: [inst.instanceId] });
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel([inst.instanceId]); }
    else if (e.key === 'd') dispatch({ type: 'duplicate', instanceIds: [inst.instanceId] });
    void idx;
  };

  if (sources.length === 0) {
    return (
      <WorkspaceShell
        title={t('organize.title')}
        error={loadError ?? runError?.detail}
        steps={[{ key: 'pick', label: t('steps.pick'), state: 'now' }]}
        side={<p className="text-[13px] text-text-muted">{t('organize.intro')}</p>}
      >
        <Dropzone
          onFiles={(files) => void addFiles(files)}
          accept=".pdf"
          multiple
          title={t('organize.drop')}
          hint={t('organize.intro')}
        />
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell
      title={t('organize.title')}
      error={loadError ?? runError?.detail}
      steps={[
        { key: 'pick', label: t('steps.pick'), state: 'done' },
        { key: 'organize', label: t('organize.step_organize'), state: 'now' },
        { key: 'download', label: t('steps.download'), state: progress?.value === 100 ? 'done' : 'todo' },
      ]}
      side={
        <div className="flex flex-col gap-2" data-testid="organize-toolbar">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => dispatch({ type: 'duplicate', instanceIds: selectedIds })} disabled={selectedIds.length === 0}>
              {t('organize.duplicate')}
            </Button>
            <Button variant="secondary" onClick={() => dispatch({ type: 'delete', instanceIds: selectedIds })} disabled={selectedIds.length === 0}>
              {t('organize.delete')}
            </Button>
            <Button variant="secondary" onClick={() => dispatch({ type: 'rotate', instanceIds: selectedIds, delta: 90 })} disabled={selectedIds.length === 0}>
              {t('organize.rotate_cw')}
            </Button>
            <Button variant="secondary" onClick={() => dispatch({ type: 'rotate', instanceIds: selectedIds, delta: 270 })} disabled={selectedIds.length === 0}>
              {t('organize.rotate_ccw')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => insertBlankAfter(selectedIds.at(-1) ?? manifest.instances.at(-1)?.instanceId ?? null)}>
              {t('organize.insert_blank')}
            </Button>
            <Button variant="secondary" onClick={() => insertPdfFile()}>{t('organize.insert_pdf')}</Button>
            <Button variant="secondary" onClick={() => void exportPdf(selectedIds)} disabled={selectedIds.length === 0}>
              {t('organize.extract')}
            </Button>
            <Button variant="secondary" onClick={() => void scanBlanks()} disabled={scanning || busy} data-testid="organize-scan-blanks">
              {scanning ? t('organize.scanning') : t('organize.scan_blanks')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setHistoryState((h) => undo(h))} disabled={!canUndo(historyState)} aria-label={t('organize.undo')}>
              {t('organize.undo')}
            </Button>
            <Button variant="secondary" onClick={() => setHistoryState((h) => redo(h))} disabled={!canRedo(historyState)} aria-label={t('organize.redo')}>
              {t('organize.redo')}
            </Button>
            <Button variant="secondary" onClick={() => sel(manifest.instances.length === selected.size ? 'none' : 'all')}>
              {manifest.instances.length === selected.size ? t('organize.select_none') : t('organize.select_all')}
            </Button>
          </div>
          {progress && !busy ? <span className="text-[13px] text-text-muted">{progress.label}</span> : null}
          {exportNotes.length > 0 ? (
            <div className="rounded-lg border border-border-strong bg-surface-card p-2 text-[13px] text-text-muted" data-testid="organize-notes">
              {exportNotes.map((n, i) => <p key={i}>{n}</p>)}
            </div>
          ) : null}
          <Button onClick={() => void exportPdf(null)} disabled={busy} data-testid="organize-export">
            {busy ? t('organize.exporting') : t('organize.export_cta')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="flex-1">
          <OrganizePageGrid
            manifest={manifest}
            sources={sources}
            selected={selected}
            verdicts={blankVerdicts}
            onToggle={(id) => sel([id])}
            onMove={move}
            onMoveBy={moveBy}
            onKey={onKeyDownTile}
          />
        </div>
        <div className="lg:w-80 shrink-0">
          <OrganizeBookmarksPanel
            instances={manifest.instances}
            bookmarks={bookmarks}
            setBookmarks={setBookmarks}
            past={bookmarkPast}
            setPast={setBookmarkPast}
            future={bookmarkFuture}
            setFuture={setBookmarkFuture}
            onNavigate={(instanceId) => {
              sel([instanceId]);
              document
                .getElementById(`organize-tile-${instanceId}`)
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }}
          />
        </div>
      </div>
    </WorkspaceShell>
  );
}

/** Page-instance grid: thumbnails render LAZILY (IntersectionObserver),
 * keyed by instanceId — duplicate source pages render independently and
 * display position never doubles as identity. */
function OrganizePageGrid({
  manifest,
  sources,
  selected,
  verdicts,
  onToggle,
  onMove,
  onMoveBy,
  onKey,
}: {
  manifest: OrganizeManifest;
  sources: SourceDoc[];
  selected: Set<string>;
  verdicts: Map<string, BlankVerdict>;
  onToggle: (id: string) => void;
  onMove: (id: string, targetId: string) => void;
  onMoveBy: (id: string, delta: number) => void;
  onKey: (e: React.KeyboardEvent, inst: PageInstance, idx: number) => void;
}) {
  const { t } = useTranslation('common');
  return (
    <div role="listbox" aria-label={t('organize.pages_label')} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="organize-grid">
      {manifest.instances.map((inst, idx) => (
        <OrganizeTile
          key={inst.instanceId}
          inst={inst}
          idx={idx}
          total={manifest.instances.length}
          source={sources.find((s) => s.sourceId === inst.sourceId) ?? null}
          isSelected={selected.has(inst.instanceId)}
          verdict={verdicts.get(inst.instanceId) ?? null}
          onToggle={onToggle}
          onMove={onMove}
          onMoveBy={onMoveBy}
          onKey={onKey}
        />
      ))}
    </div>
  );
}

function OrganizeTile({
  inst,
  idx,
  total,
  source,
  isSelected,
  verdict,
  onToggle,
  onMove,
  onMoveBy,
  onKey,
}: {
  inst: PageInstance;
  idx: number;
  total: number;
  source: SourceDoc | null;
  isSelected: boolean;
  verdict: BlankVerdict | null;
  onToggle: (id: string) => void;
  onMove: (id: string, targetId: string) => void;
  onMoveBy: (id: string, delta: number) => void;
  onKey: (e: React.KeyboardEvent, inst: PageInstance, idx: number) => void;
}) {
  const { t } = useTranslation('common');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || rendered || !source || !canvasRef.current) return;
    let alive = true;
    void (async () => {
      try {
        await renderPageToCanvas(source.bytes, inst.sourcePage ?? 1, canvasRef.current!, 0.35);
        if (alive) setRendered(true);
      } catch {
        /* thumbnail failure is non-fatal; tile still functions */
      }
    })();
    return () => {
      alive = false;
    };
  }, [visible, rendered, source, inst.sourcePage]);

  const rot = inst.rotation;
  return (
    <div
      ref={wrapRef}
      role="option"
      aria-selected={isSelected}
      tabIndex={0}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/organize-id', inst.instanceId)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/organize-id');
        if (id) onMove(id, inst.instanceId);
      }}
      onKeyDown={(e) => onKey(e, inst, idx)}
      onClick={() => onToggle(inst.instanceId)}
      id={`organize-tile-${inst.instanceId}`}
      data-testid={`organize-tile-${inst.instanceId}`}
      className={`cursor-pointer rounded-lg border p-2 text-[12px] ${
        isSelected ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface-card'
      }`}
    >
      <div className="flex items-center justify-center" style={{ minHeight: 90 }}>
        {inst.blank ? (
          <div
            className="border border-dashed border-border-strong bg-surface-base"
            style={{ width: inst.blank.widthPt * 0.18, height: inst.blank.heightPt * 0.18 }}
            aria-label={t('organize.blank_page')}
          />
        ) : (
          <div style={{ transform: `rotate(${rot}deg)` }}>
            <canvas ref={canvasRef} className={rendered ? 'block' : 'hidden'} />
            {!rendered ? <div className="h-24 w-16 animate-pulse rounded bg-surface-base" /> : null}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between text-text-muted">
        <span className="font-semibold text-text-primary">
          {idx + 1}
          {verdict === 'blank' ? (
            <span className="ml-1 rounded bg-tone-green-soft px-1 text-tone-green" data-testid="blank-badge">{t('organize.blank_page')}</span>
          ) : verdict === 'near' ? (
            <span className="ml-1 rounded bg-tone-orange-soft px-1 text-tone-orange">{t('organize.near_blank')}</span>
          ) : verdict === 'unknown' ? (
            <span className="ml-1 rounded bg-surface-base px-1" title={t('organize.unknown_hint')}>?</span>
          ) : null}
        </span>
        <span className="truncate" title={source?.name}>
          {inst.blank ? t('organize.blank_page') : `${source?.name ?? '?'} · ${inst.sourcePage}`}
          {rot !== 0 ? ` ↻${rot}°` : ''}
        </span>
      </div>
      <div className="mt-1 flex gap-1">
        <button
          type="button"
          aria-label={t('organize.move_left', { n: idx + 1 })}
          data-testid={`tile-left-${idx + 1}`}
          disabled={idx === 0}
          onClick={(e) => { e.stopPropagation(); onMoveBy(inst.instanceId, -1); }}
          className="min-h-8 min-w-8 rounded border border-border-strong text-text-muted disabled:opacity-40"
        >
          ←
        </button>
        <button
          type="button"
          aria-label={t('organize.move_right', { n: idx + 1 })}
          data-testid={`tile-right-${idx + 1}`}
          disabled={idx === total - 1}
          onClick={(e) => { e.stopPropagation(); onMoveBy(inst.instanceId, 1); }}
          className="min-h-8 min-w-8 rounded border border-border-strong text-text-muted disabled:opacity-40"
        >
          →
        </button>
      </div>
    </div>
  );
}
