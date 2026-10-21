import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useDropFiles } from '../../hooks/use-drop-files';
import { pickDirectory } from '../../lib/dir-picker';
import { takePendingFiles, appendPendingFiles } from '../../lib/handoff';
import { useThumbnails } from '../../hooks/use-thumbnails';
import { engine } from '../../engine/client';
import { deliverBytes, deliverBytesMulti, type DeliverEntry } from '../../lib/download';
import { isDesktopSaveAvailable } from '../../lib/desktop-save';
import { checkImageIntake } from '../../lib/image-intake';
import { isEncryptedError } from '../../lib/suggest';
import { formatBytes } from '../../lib/format';
import type { GridPos9, StampWatermarkOptions } from '../../engine/pdf-lib';
import { Dropzone } from '../ui/dropzone';
import { ErrorBanner } from '../ui/error-banner';
import { Button } from '../ui/button';
import { SaveElsewhereButton } from '../ui/save-elsewhere-button';
import { WorkspaceShell } from './workspace-shell';
import { ThumbnailStrip } from './thumbnail-strip';
import { PositionGrid } from './position-grid';
import { FileIcon } from '../ui/icons';

/*
 * Watermark tool (v0.8.0 phase 2): form-based text/image stamping. The edit
 * model is re-apply (adjust the form, run again) — visual canvas editing is
 * the v0.9 annotate non-goal. Folder batch (day-1, D3): same options for
 * every PDF; per-file gate + try/catch with a named "X/Y thành công" report;
 * WEB delivers each output as it completes (no output accumulation — bounded
 * peak memory), DESKTOP keeps ONE Save-As dialog with sibling writes.
 */

type Tab = 'text' | 'image';

const ROTATION_PRESETS = [0, 45, 90];

function outputName(original: string): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'watermarked';
  return `${base}-watermarked.pdf`;
}

export function WatermarkTool() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { files, error: fileError, add, clear } = useDropFiles();
  // Home-sheet handoff (one-shot take; StrictMode's double effect adds nothing).
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);

  const source = files[0] ?? null;
  const [numPages, setNumPages] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [encrypted, setEncrypted] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('text');
  // Text options.
  const [text, setText] = useState('BẢN MẪU');
  const [fontSize, setFontSize] = useState(48);
  const [opacity, setOpacity] = useState(50);
  const [rotation, setRotation] = useState(45);
  const [position, setPosition] = useState<GridPos9>('center');
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [tiled, setTiled] = useState(false);
  const [tileColumns, setTileColumns] = useState(3);
  // Image options.
  const [image, setImage] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [imageOpacity, setImageOpacity] = useState(50);
  const [imageScale, setImageScale] = useState(30);
  const [imageError, setImageError] = useState<string | null>(null);

  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const genRef = useRef(0);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';
  const locale = lng === 'vi' ? 'vi-VN' : 'en-US';

  // File change rebuild (finding 13): stale selections/encryption state from
  // a previous file never survive — the engine clamp is the backstop only.
  useEffect(() => {
    const gen = (genRef.current += 1);
    setEncrypted(false);
    setLoadError(null);
    setNumPages(0);
    setSelected(new Set());
    if (!source) return;
    let cancelled = false;
    void (async () => {
      try {
        const { info } = await engine.loadPdf(source.bytes);
        if (cancelled || genRef.current !== gen) return;
        setNumPages(info.numPages);
        const all = new Set<number>();
        for (let p = 1; p <= info.numPages; p += 1) all.add(p);
        setSelected(all);
      } catch (e) {
        if (cancelled || genRef.current !== gen) return;
        setNumPages(0);
        setSelected(new Set());
        if (isEncryptedError(e)) setEncrypted(true);
        else setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const thumbJobs =
    source && numPages > 0
      ? Array.from({ length: numPages }, (_, i) => ({
          id: `p${i + 1}`,
          bytes: source.bytes,
          page: i + 1,
          version: genRef.current,
        }))
      : [];
  const { urlFor, observe } = useThumbnails(thumbJobs);

  const toggle = useCallback((page: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  }, []);

  const buildOpts = (): StampWatermarkOptions => {
    const pages = [...selected].sort((a, b) => a - b);
    const shared = { position, offsetX, offsetY };
    if (tab === 'image') {
      if (!image) throw new Error(t('watermark.err_no_image'));
      return {
        mode: 'image',
        imageBytes: image.bytes,
        opacity: imageOpacity / 100,
        scale: imageScale / 100,
        pages,
        ...shared,
      };
    }
    return {
      mode: 'text',
      text: text.trim() || 'BẢN MẪU',
      fontSize,
      opacity: opacity / 100,
      rotation,
      tiled,
      tileColumns,
      pages,
      ...shared,
    };
  };

  const run = async (dest: 'download' | 'pick' = 'download') => {
    setRunError(null);
    setBatchNote(null);
    if (!source) {
      setRunError(t('watermark.err_no_file'));
      return;
    }
    if (selected.size === 0) {
      setRunError(t('watermark.err_no_selection'));
      return;
    }
    let opts: StampWatermarkOptions;
    try {
      opts = buildOpts();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
      return;
    }
    try {
      setProgress({ value: 20, label: t('watermark.progress_working') });
      const out = await engine.stampWatermark(source.bytes, opts);
      if (await deliverBytes(out, outputName(source.file.name), dest)) {
        setProgress({ value: 100, label: t('watermark.progress_done') });
      } else {
        setProgress(null); // picker cancelled — not an error
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRunError(t('watermark.err_failed', { message }));
      setProgress(null);
    }
  };

  // Folder batch (D3): per-file gate + try/catch; web delivers per file,
  // desktop collects into ONE Save-As dialog with sibling writes.
  const runBatch = async () => {
    setRunError(null);
    setBatchNote(null);
    if (selected.size === 0) {
      setRunError(t('watermark.err_no_selection'));
      return;
    }
    let opts: StampWatermarkOptions;
    try {
      opts = buildOpts();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
      return;
    }
    const outcome = await pickDirectory(['.pdf']);
    if (!outcome.ok) {
      setBatchNote(t('home.batch_too_large', { size: formatBytes(outcome.totalBytes, locale) }));
      return;
    }
    if (outcome.files.length === 0) {
      setBatchNote(t('home.folder_empty'));
      return;
    }
    const desktop = isDesktopSaveAvailable();
    const entries: DeliverEntry[] = [];
    const failed: string[] = [];
    let ok = 0;
    for (const [i, f] of outcome.files.entries()) {
      setProgress({
        value: 10 + Math.round((80 * i) / outcome.files.length),
        label: t('watermark.progress_batch', { done: i + 1, total: outcome.files.length }),
      });
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        await engine.loadPdf(bytes); // per-file validity + lock gate
        const out = await engine.stampWatermark(bytes, opts);
        if (desktop) entries.push({ bytes: out, filename: outputName(f.name) });
        else await deliverBytes(out, outputName(f.name), 'download');
        ok += 1;
      } catch {
        failed.push(f.name);
      }
    }
    if (desktop && entries.length > 0) await deliverBytesMulti(entries);
    setProgress({ value: 100, label: t('watermark.progress_done') });
    setBatchNote(
      t('watermark.batch_summary', {
        ok,
        total: outcome.files.length,
        failed: failed.join(', '),
      }),
    );
  };

  const parkToDecrypt = () => {
    if (!source) return;
    appendPendingFiles([source.file], { mode: 'decrypt' });
    navigate('/tools/encrypt');
  };

  const pickImage = async (list: FileList | null) => {
    setImageError(null);
    const f = list?.[0];
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const verdict = checkImageIntake(bytes);
      if (!verdict.ok) {
        setImageError(
          verdict.reason === 'too-many-pixels'
            ? t('watermark.err_image_too_big')
            : t('watermark.err_image_unsupported'),
        );
        return;
      }
      setImage({ bytes, name: f.name });
    } catch (e) {
      setImageError(e instanceof Error ? e.message : String(e));
    }
  };

  const reset = () => {
    clear();
    setNumPages(0);
    setSelected(new Set());
    setEncrypted(false);
    setLoadError(null);
    setProgress(null);
    setRunError(null);
    setBatchNote(null);
  };

  const busy = progress !== null && progress.value < 100;

  return (
    <WorkspaceShell
      title={t('watermark.title')}
      meta={
        source
          ? t('meta.file_pages', {
              name: source.file.name,
              count: numPages,
              size: formatBytes(source.file.size, locale),
            })
          : undefined
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: source ? 'done' : 'now' },
        { key: 'configure', label: t('steps.configure'), state: source ? 'now' : 'todo' },
        { key: 'download', label: t('steps.download'), state: 'todo' },
      ]}
      error={fileError ?? runError ?? loadError}
      side={
        <>
          {encrypted ? (
            <div className="flex flex-col gap-2">
              <p className="text-[13.5px] text-text-primary">{t('watermark.err_encrypted')}</p>
              <Button onClick={parkToDecrypt}>{t('watermark.decrypt_cta')}</Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-border-strong p-1" role="tablist">
                {(['text', 'image'] as Tab[]).map((tabKey) => (
                  <button
                    key={tabKey}
                    type="button"
                    role="tab"
                    aria-selected={tab === tabKey}
                    onClick={() => setTab(tabKey)}
                    className={`min-h-9 rounded-md text-[13px] font-semibold transition ${
                      tab === tabKey ? 'bg-accent text-text-on-accent' : 'text-text-muted hover:bg-surface-hover'
                    }`}
                  >
                    {t(tabKey === 'text' ? 'watermark.tab_text' : 'watermark.tab_image')}
                  </button>
                ))}
              </div>

              {tab === 'text' ? (
                <fieldset>
                  <legend className="text-sm font-bold">{t('watermark.content_label')}</legend>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={2}
                    className="mt-2 w-full rounded-lg border border-border-strong bg-surface-card px-3 py-2 text-sm"
                    placeholder={t('watermark.content_placeholder')}
                  />
                  <label className="mt-3 block text-[13px] font-semibold">
                    {t('watermark.font_size')}
                    <input
                      type="number"
                      min={8}
                      max={200}
                      value={fontSize}
                      onChange={(e) => setFontSize(Math.max(8, Math.min(200, Number(e.target.value) || 48)))}
                      className="mt-1 w-full rounded-lg border border-border-strong bg-surface-card px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="mt-3 block text-[13px] font-semibold">
                    {t('watermark.opacity', { value: opacity })}
                    <input
                      type="range"
                      min={5}
                      max={100}
                      value={opacity}
                      onChange={(e) => setOpacity(Number(e.target.value))}
                      className="mt-1 w-full accent-accent"
                    />
                  </label>
                  <fieldset className="mt-3">
                    <legend className="text-[13px] font-semibold">{t('watermark.rotation')}</legend>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {ROTATION_PRESETS.map((deg) => (
                        <button
                          key={deg}
                          type="button"
                          onClick={() => setRotation(deg)}
                          className={`min-h-9 rounded-lg border px-3 text-[13px] font-semibold tabular-nums ${
                            rotation === deg ? 'border-accent bg-surface-card' : 'border-border-strong bg-surface-card'
                          }`}
                        >
                          {deg}°
                        </button>
                      ))}
                      <input
                        type="number"
                        min={0}
                        max={360}
                        value={rotation}
                        onChange={(e) =>
                          setRotation(Math.max(0, Math.min(360, Number(e.target.value) || 0)))
                        }
                        aria-label={t('watermark.rotation_free')}
                        className="w-18 rounded-lg border border-border-strong bg-surface-card px-2 py-1.5 text-[13px] tabular-nums"
                      />
                    </div>
                  </fieldset>
                  <label className="mt-3 flex items-center gap-2 text-[13px] font-semibold">
                    <input
                      type="checkbox"
                      checked={tiled}
                      onChange={(e) => setTiled(e.target.checked)}
                      className="h-4 w-4 accent-accent"
                    />
                    {t('watermark.tiled')}
                  </label>
                  {tiled ? (
                    <label className="mt-2 block text-[13px] font-semibold">
                      {t('watermark.tile_columns')}
                      <input
                        type="range"
                        min={2}
                        max={8}
                        value={tileColumns}
                        onChange={(e) => setTileColumns(Number(e.target.value))}
                        className="mt-1 w-full accent-accent"
                      />
                      <span className="tabular-nums">{tileColumns}</span>
                    </label>
                  ) : null}
                </fieldset>
              ) : (
                <fieldset>
                  <legend className="text-sm font-bold">{t('watermark.image_pick')}</legend>
                  <label className="mt-2 inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-border-strong bg-surface-card px-4 text-sm font-semibold hover:bg-surface-hover">
                    {image ? t('watermark.image_change') : t('watermark.image_pick')}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                      className="hidden"
                      onChange={(e) => void pickImage(e.target.files)}
                    />
                  </label>
                  {image ? (
                    <p className="mt-1.5 truncate text-[13px] text-text-muted">{image.name}</p>
                  ) : (
                    <p className="mt-1.5 text-[13px] text-text-muted">{t('watermark.image_none_hint')}</p>
                  )}
                  {imageError ? <ErrorBanner error={imageError} /> : null}
                  <label className="mt-3 block text-[13px] font-semibold">
                    {t('watermark.image_opacity', { value: imageOpacity })}
                    <input
                      type="range"
                      min={5}
                      max={100}
                      value={imageOpacity}
                      onChange={(e) => setImageOpacity(Number(e.target.value))}
                      className="mt-1 w-full accent-accent"
                    />
                  </label>
                  <label className="mt-3 block text-[13px] font-semibold">
                    {t('watermark.image_scale', { value: imageScale })}
                    <input
                      type="range"
                      min={10}
                      max={100}
                      value={imageScale}
                      onChange={(e) => setImageScale(Number(e.target.value))}
                      className="mt-1 w-full accent-accent"
                    />
                  </label>
                </fieldset>
              )}

              <fieldset>
                <legend className="text-sm font-bold">{t('watermark.position')}</legend>
                <PositionGrid value={position} onChange={setPosition} label={t('watermark.position')} />
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="block text-[13px] font-semibold">
                    X
                    <input
                      type="number"
                      value={offsetX}
                      onChange={(e) => setOffsetX(Number(e.target.value) || 0)}
                      className="mt-1 w-full rounded-lg border border-border-strong bg-surface-card px-2 py-1.5 text-[13px] tabular-nums"
                    />
                  </label>
                  <label className="block text-[13px] font-semibold">
                    Y
                    <input
                      type="number"
                      value={offsetY}
                      onChange={(e) => setOffsetY(Number(e.target.value) || 0)}
                      className="mt-1 w-full rounded-lg border border-border-strong bg-surface-card px-2 py-1.5 text-[13px] tabular-nums"
                    />
                  </label>
                </div>
              </fieldset>

              <Button
                onClick={() => void run()}
                disabled={!source || selected.size === 0 || busy || (tab === 'image' && !image)}
              >
                {t('watermark.cta')}
              </Button>
              <SaveElsewhereButton
                disabled={!source || selected.size === 0 || busy || (tab === 'image' && !image)}
                onClick={() => void run('pick')}
              />
              <Button variant="secondary" onClick={() => void runBatch()} disabled={selected.size === 0 || busy}>
                {t('watermark.cta_batch')}
              </Button>
              {progress ? null : (
                <span className="text-[13px] text-text-muted">{t('watermark.progress_idle')}</span>
              )}
            </>
          )}
        </>
      }
      progress={progress}
      onReset={reset}
    >
      <Dropzone
        title={t('watermark.dropzone_title')}
        hint={t('watermark.dropzone_hint')}
        accept="application/pdf,.pdf"
        multiple={false}
        onFiles={(f) => {
          clear();
          void add(f.slice(0, 1));
        }}
      />
      {batchNote ? <ErrorBanner error={batchNote} /> : null}
      {source ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-border-default p-2.5 text-[13.5px]">
          <span className="text-text-muted"><FileIcon size={17} /></span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{source.file.name}</span>
          <span className="ml-auto text-xs whitespace-nowrap text-text-muted tabular-nums">
            {formatBytes(source.file.size, locale)} · {t('units.pages', { count: numPages })}
          </span>
        </div>
      ) : null}
      {numPages > 0 ? (
        <>
          <div className="mt-3.5 mb-2.5 flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
            <span className="font-bold text-text-primary">
              {t('watermark.selected_count', { count: selected.size, total: numPages })}
            </span>
            <span>· {t('watermark.thumb_hint')}</span>
          </div>
          <ThumbnailStrip
            pages={Array.from({ length: numPages }, (_, i) => i + 1).map((p) => ({
              key: `p${p}`,
              pageNumber: p,
              url: urlFor(`p${p}`),
              selected: selected.has(p),
            }))}
            fullscreenTitle={(n) => t('a11y.page_n', { n })}
            closeLabel={t('home.sheet_close')}
            register={observe}
            onToggle={(pageNumber: number) => toggle(pageNumber)}
          />
        </>
      ) : null}
    </WorkspaceShell>
  );
}

// token-mapped
