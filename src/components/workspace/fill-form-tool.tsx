import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropFiles } from '../../hooks/use-drop-files';
import { takePendingFiles } from '../../lib/handoff';
import { useThumbnails } from '../../hooks/use-thumbnails';
import { engine } from '../../engine/client';
import { deliverBytes } from '../../lib/download';
import { formatBytes } from '../../lib/format';
import { Dropzone } from '../ui/dropzone';
import { Hint } from '../ui/hint';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { SaveElsewhereButton } from '../ui/save-elsewhere-button';
import { WorkspaceShell } from './workspace-shell';
import { ThumbnailStrip } from './thumbnail-strip';
import { FileIcon, LockIcon } from '../ui/icons';
import type {
  FormFieldInfo,
  FormFillInput,
  FormInspectResultAll,
} from '../../engine/pdf-lib';

// Static Roboto Regular TTF (Apache-2.0 — see NOTICE / LICENSE-THIRD-PARTY),
// inlined as a data URL and loaded via DYNAMIC import: the ~690KB base64
// lands in its own lazy chunk next to pdf-lib+fontkit (never the entry
// bundle), and fetch(data:) works offline once chunks are precached — no
// extra precache-config coupling for a separate font asset.
// ?inline embeds the TTF as a base64 data URL in this lazy chunk (see the
// comment above). Decoded with atob — fetch() on data: URLs is rejected by
// current Chromium, which silently killed the first e2e run of this path.
const ROBOTO_BYTES_PROMISE = import('../../assets/fonts/Roboto-Regular.ttf?inline').then(
  (m): Uint8Array => {
    const b64 = m.default.slice(m.default.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  },
);

type Refusal = 'no-form' | 'xfa';

interface RunError {
  key: string;
  values?: Record<string, string | number>;
}

const TYPE_BADGE_KEY: Record<FormFieldInfo['type'], string | null> = {
  text: null, // text fields keep the multiline/readonly badges only
  checkbox: 'fill_form.badge_checkbox',
  radio: 'fill_form.badge_choice',
  dropdown: 'fill_form.badge_dropdown',
  optionlist: 'fill_form.badge_dropdown',
  signature: 'fill_form.badge_signature',
  other: 'fill_form.badge_other',
};

function outputName(original: string): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'filled';
  return `${base}-filled.pdf`;
}

function isEncryptedError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /encrypted/i.test(message);
}

export function FillFormTool() {
  const { t, i18n } = useTranslation();
  const { files, error: fileError, add, clear } = useDropFiles();
  // Home-sheet handoff (one-shot take; StrictMode's double effect adds nothing).
  useEffect(() => {
    const taken = takePendingFiles();
    if (taken?.files.length) void add([taken.files[0]]);
  }, [add]);

  // Decrypted working copy, pinned to the exact src bytes it came from so a
  // new drop can never inherit the previous file's decryption.
  const [decrypted, setDecrypted] = useState<{ for: Uint8Array; bytes: Uint8Array } | null>(null);
  const [encrypted, setEncrypted] = useState(false);
  const [decryptPass, setDecryptPass] = useState('');
  const [inspect, setInspect] = useState<FormInspectResultAll | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loadSeq, setLoadSeq] = useState(0);
  const [progress, setProgress] = useState<{ value: number; label: string } | null>(null);
  const [runError, setRunError] = useState<RunError | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Flatten (phase 6b): irreversible bake, gated behind a confirm dialog with
  // a HARD extra warning when the document carries a signature field (R15).
  const [flatten, setFlatten] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Fields whose appearance/flatten step failed (R15 resilience notice).
  const [skipped, setSkipped] = useState<string[]>([]);
  const lng = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';
  const locale = lng === 'vi' ? 'vi-VN' : 'en-US';

  // Perf (R15, large forms): every input is UNCONTROLLED — typing never
  // re-renders the panel. Values are read from the DOM at export time; only
  // the names touched by the user (dirty set in a ref) are sent, so an
  // untouched field keeps the producer's value/appearance exactly.
  const formRef = useRef<HTMLFormElement>(null);
  const dirtyRef = useRef<Set<string>>(new Set());
  const markDirty = (name: string) => {
    dirtyRef.current.add(name);
  };

  const src = files.length > 0 ? files[0] : null;
  const working =
    decrypted && src && decrypted.for === src.bytes ? decrypted.bytes : (src?.bytes ?? null);
  const refusal: Refusal | null = !inspect
    ? null
    : inspect.hasXFA
      ? 'xfa'
      : inspect.totalFields === 0
        ? 'no-form'
        : null;

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // ---- load + inspect (runs again on the decrypted working copy) -----------
  useEffect(() => {
    let cancelled = false;
    setLoadSeq((n) => n + 1);
    setNumPages(0);
    setCurrentPage(1);
    setInspect(null);
    dirtyRef.current = new Set();
    setFlatten(false);
    setSkipped([]);
    if (!working) {
      setEncrypted(false);
      setDecrypted(null);
      return;
    }
    void (async () => {
      try {
        const { info } = await engine.loadPdf(working);
        if (cancelled) return;
        setNumPages(info.numPages);
      } catch (e) {
        if (cancelled) return;
        if (isEncryptedError(e)) {
          setEncrypted(true);
          return;
        }
        setRunError({
          key: 'fill_form.err_failed',
          values: { message: e instanceof Error ? e.message : String(e) },
        });
        return;
      }
      try {
        const { inspectFormFieldsAll } = await import('../../engine/pdf-lib');
        const result = await inspectFormFieldsAll(working);
        if (cancelled) return;
        setInspect(result);
      } catch (e) {
        if (cancelled) return;
        setRunError({
          key: 'fill_form.err_failed',
          values: { message: e instanceof Error ? e.message : String(e) },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [working]);

  const decrypt = async () => {
    if (!src) return;
    if (!decryptPass) {
      setRunError({ key: 'fill_form.err_no_password' });
      return;
    }
    setRunError(null);
    setBusy(true);
    try {
      setProgress({ value: 30, label: t('fill_form.progress_decrypting') });
      const plain = await engine.decryptPdf(src.bytes, decryptPass);
      setDecrypted({ for: src.bytes, bytes: plain });
      setEncrypted(false);
      setProgress(null);
    } catch {
      // qpdf exits non-zero for every decrypt failure; wrong password is the
      // overwhelmingly common one (same mapping as the encrypt tool).
      setRunError({ key: 'fill_form.err_wrong_password' });
      setProgress(null);
    } finally {
      setDecryptPass(''); // never keep the password after the run
      setBusy(false);
    }
  };

  // ---- export: collect dirty uncontrolled inputs, fill (+ flatten) ---------
  const collectInput = (): FormFillInput => {
    const input: FormFillInput = {};
    const root = formRef.current;
    if (!root) return input;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-fname]'))) {
      const name = el.getAttribute('data-fname');
      if (!name || !dirtyRef.current.has(name)) continue;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        (input.checkboxes ??= {})[name] = el.checked;
      } else if (el instanceof HTMLInputElement && el.type === 'radio') {
        // All options of a group share the data-fname; the checked one wins.
        if (el.checked) (input.radios ??= {})[name] = el.value;
      } else if (el instanceof HTMLSelectElement) {
        (input.choices ??= {})[name] = el.value;
      } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        (input.texts ??= {})[name] = el.value;
      }
    }
    return input;
  };

  const run = async (dest: 'download' | 'pick' = 'download') => {
    setRunError(null);
    setSucceeded(false);
    setSkipped([]);
    if (!src || !working) {
      setRunError({ key: 'fill_form.err_no_file' });
      return;
    }
    setBusy(true);
    try {
      setProgress({ value: 15, label: t('fill_form.progress_working') });
      const [fillModule, fontBuf] = await Promise.all([
        import('../../engine/pdf-lib'),
        ROBOTO_BYTES_PROMISE,
      ]);
      setProgress({ value: 55, label: t('fill_form.progress_working') });
      const result = await fillModule.fillFormFields(
        working.slice(),
        collectInput(),
        fontBuf,
        { flatten },
      );
      setProgress({ value: 85, label: t('fill_form.progress_working') });
      setSkipped(result.skipped);
      if (await deliverBytes(result.bytes, outputName(src.file.name), dest)) {
        setProgress({ value: 100, label: t('fill_form.progress_done') });
        setSucceeded(true);
      } else {
        setProgress(null); // picker cancelled — not an error
      }
    } catch (e) {
      setRunError({
        key: 'fill_form.err_failed',
        values: { message: e instanceof Error ? e.message : String(e) },
      });
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  // Flatten is irreversible — route through the confirm dialog (R15). The
  // chosen destination is parked so the confirm button resumes the exact run
  // the user asked for (download or save-elsewhere).
  const pendingDestRef = useRef<'download' | 'pick'>('download');
  const requestRun = (dest: 'download' | 'pick') => {
    pendingDestRef.current = dest;
    if (flatten) setConfirmOpen(true);
    else void run(dest);
  };

  const resetAll = () => {
    clear();
    setDecrypted(null);
    setEncrypted(false);
    setDecryptPass('');
    setProgress(null);
    setRunError(null);
    setSucceeded(false);
    setFlatten(false);
    setConfirmOpen(false);
    setSkipped([]);
  };

  // ---- page preview (serialized renders; pdf.js rejects overlapping ones) ---
  const pendingPreviewRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!working || numPages === 0 || encrypted || refusal) return;
    const render = async () => {
      const { renderPageToCanvas } = await import('../../engine/pdfjs');
      const canvas = previewCanvasRef.current;
      if (!canvas) return;
      try {
        await renderPageToCanvas(working, currentPage, canvas, 1.0);
      } catch (e) {
        setRunError({
          key: 'fill_form.err_failed',
          values: { message: e instanceof Error ? e.message : String(e) },
        });
      }
    };
    pendingPreviewRef.current = pendingPreviewRef.current.then(render, render);
  }, [working, numPages, currentPage, encrypted, refusal]);

  const thumbJobs =
    working && numPages > 0
      ? Array.from({ length: numPages }, (_, i) => ({
          id: `p${i + 1}`,
          bytes: working,
          page: i + 1,
          version: loadSeq,
        }))
      : [];
  const { urlFor, observe } = useThumbnails(thumbJobs);

  // ---- field list grouped by page -------------------------------------------
  const groups = useMemo(() => {
    const map = new Map<number, FormFieldInfo[]>();
    for (const f of inspect?.fields ?? []) {
      const arr = map.get(f.page) ?? [];
      arr.push(f);
      map.set(f.page, arr);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [inspect]);

  const fileErrorParts = (() => {
    if (!fileError) return null;
    const idx = fileError.indexOf(':');
    const code = idx === -1 ? fileError : fileError.slice(0, idx);
    const name = idx === -1 ? '' : fileError.slice(idx + 1);
    if (code === 'too-large') return { key: 'fill_form.err_too_large', values: { name } };
    if (code === 'not-pdf') return { key: 'fill_form.err_not_pdf', values: { name } };
    if (code === 'heic-refused') return { key: 'fill_form.err_heic', values: { name } };
    return null;
  })();

  const error = fileErrorParts
    ? t(fileErrorParts.key, fileErrorParts.values)
    : runError
      ? t(runError.key, runError.values)
      : null;

  const ready = Boolean(inspect && !refusal && !encrypted && numPages > 0);
  const runDisabled = !ready || busy;
  const signed = Boolean(inspect?.hasSignature);

  const refusalCopy = (() => {
    if (refusal === 'xfa') {
      return { title: t('fill_form.xfa_title'), desc: t('fill_form.xfa_desc') };
    }
    if (refusal === 'no-form') {
      return { title: t('fill_form.no_form_title'), desc: t('fill_form.no_form_desc') };
    }
    return null;
  })();

  const fieldControl = (f: FormFieldInfo) => {
    const label = f.label || f.name;
    if (f.readOnly || f.type === 'signature' || f.type === 'other') {
      const shown =
        f.type === 'signature'
          ? t('fill_form.signature_value')
          : f.value || t('fill_form.empty_value');
      return (
        <p
          className="mt-1.5 min-h-10 rounded-md border border-border-default bg-surface-sunken px-2.5 py-2 text-[13px] whitespace-pre-wrap"
          title={f.name}
          data-fname={f.name}
        >
          {shown}
        </p>
      );
    }
    if (f.type === 'checkbox') {
      return (
        <label className="mt-1.5 flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md border border-border-strong px-2.5 text-[13px]" title={f.name}>
          <input
            type="checkbox"
            defaultChecked={f.checked ?? false}
            onChange={() => markDirty(f.name)}
            data-fname={f.name}
            aria-label={label}
            className="min-h-[18px] min-w-[18px] accent-accent"
          />
          <span>{f.value || t('fill_form.empty_value')}</span>
        </label>
      );
    }
    if (f.type === 'radio' && (f.options?.length ?? 0) <= 4) {
      return (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5" role="radiogroup" aria-label={label}>
          {(f.options ?? []).map((opt) => (
            <label key={opt} className="flex cursor-pointer items-center gap-1.5 text-[13px]" title={f.name}>
              <input
                type="radio"
                name={`ff-${f.name}`}
                value={opt}
                defaultChecked={f.value === opt}
                onChange={() => markDirty(f.name)}
                data-fname={f.name}
                className="min-h-[18px] min-w-[18px] accent-accent"
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      );
    }
    if (f.type === 'radio' || f.type === 'dropdown' || f.type === 'optionlist') {
      const asSelect = f.type === 'radio';
      return (
        <div className="mt-1.5">
          <select
            defaultValue={f.type === 'radio' ? f.value : (f.selected?.[0] ?? '')}
            onChange={() => markDirty(f.name)}
            data-fname={f.name}
            aria-label={label}
            title={asSelect ? t('fill_form.radio_as_select_hint') : f.name}
            className="min-h-10 w-full rounded-md border border-border-strong bg-surface-card px-2.5 text-[13px]"
          >
            {f.type !== 'radio' ? (
              <option value="">{t('fill_form.empty_choice')}</option>
            ) : null}
            {(f.options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          {f.type === 'dropdown' && f.editable ? (
            <p className="mt-1 text-[12px] text-text-muted">{t('fill_form.dropdown_editable_hint')}</p>
          ) : null}
        </div>
      );
    }
    // text
    if (f.multiline) {
      return (
        <textarea
          rows={3}
          defaultValue={f.value}
          onChange={() => markDirty(f.name)}
          data-fname={f.name}
          aria-label={label}
          title={f.name}
          className="mt-1.5 w-full rounded-md border border-border-strong px-2.5 py-2 text-[13px]"
        />
      );
    }
    return (
      <input
        type="text"
        defaultValue={f.value}
        onChange={() => markDirty(f.name)}
        data-fname={f.name}
        aria-label={label}
        title={f.name}
        className="mt-1.5 min-h-10 w-full rounded-md border border-border-strong px-2.5 text-[13px]"
      />
    );
  };

  return (
    <WorkspaceShell
      title={t('fill_form.title')}
      meta={
        src
          ? t('meta.file_pages', {
              name: src.file.name,
              count: numPages,
              size: formatBytes(src.file.size, locale),
            })
          : undefined
      }
      steps={[
        { key: 'pick', label: t('steps.pick'), state: src ? 'done' : 'now' },
        { key: 'configure', label: t('steps.configure'), state: succeeded ? 'done' : ready ? 'now' : 'todo' },
        { key: 'download', label: t('steps.download'), state: succeeded ? 'now' : 'todo' },
      ]}
      error={error}
      side={
        <>
          {ready ? (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border-default p-2.5 text-[13px]">
              <input
                type="checkbox"
                checked={flatten}
                onChange={(e) => setFlatten(e.target.checked)}
                data-testid="flatten-toggle"
                className="mt-0.5 min-h-[18px] min-w-[18px] accent-accent"
              />
              <span>
                {t('fill_form.flatten_toggle')}
                <small className="mt-0.5 block text-text-muted">{t('fill_form.flatten_hint')}</small>
              </span>
            </label>
          ) : null}
          <Button onClick={() => requestRun('download')} disabled={runDisabled}>
            {t('fill_form.cta')}
          </Button>
          <SaveElsewhereButton disabled={runDisabled} onClick={() => requestRun('pick')} />
          {progress ? null : (
            <span className="text-[13px] text-text-muted">{t('fill_form.progress_idle_all')}</span>
          )}
          <Hint variant="info" dismissKey="hint-fill-form-scope">
            <span className="block">{t('fill_form.scope_all_hint')}</span>
            <span className="mt-1.5 block">{t('fill_form.keep_interactive_hint')}</span>
          </Hint>
        </>
      }
      progress={progress}
      onReset={resetAll}
    >
      <div className="mt-3.5">
        <Dropzone
          title={t('fill_form.dropzone_title')}
          hint={t('fill_form.dropzone_hint')}
          accept="application/pdf,.pdf"
          multiple={false}
          onFiles={(f) => {
            if (f.length === 0) return;
            clear();
            setDecrypted(null);
            setEncrypted(false);
            setDecryptPass('');
            setProgress(null);
            setRunError(null);
            setSucceeded(false);
            setFlatten(false);
            setSkipped([]);
            void add([f[0]]);
          }}
        />
      </div>

      {src ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-border-default p-2.5 text-[13.5px]">
          <span className="text-text-muted"><FileIcon size={17} /></span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{src.file.name}</span>
          <span className="ml-auto text-xs whitespace-nowrap text-text-muted tabular-nums">
            {formatBytes(src.file.size, locale)}
            {numPages > 0 ? ` · ${t('units.pages', { count: numPages })}` : ''}
          </span>
        </div>
      ) : null}

      {encrypted ? (
        <div className="mt-4">
          <Hint variant="warning" dismissKey="hint-fill-form-decrypt">
            <strong className="block">{t('fill_form.encrypted_title')}</strong>
            <span className="block">{t('fill_form.encrypted_desc')}</span>
          </Hint>
          <div className="mt-3 flex flex-col gap-2.5">
            <label className="block text-sm">
              <span className="mb-1 block font-bold">{t('fill_form.decrypt_pass_label')}</span>
              <input
                type="password"
                autoComplete="current-password"
                value={decryptPass}
                onChange={(e) => setDecryptPass(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void decrypt();
                }}
                placeholder={t('fill_form.decrypt_pass_placeholder')}
                className="min-h-11 w-full rounded-lg border border-border-strong px-3.5 text-sm"
              />
            </label>
            <div>
              <Button variant="secondary" disabled={busy} onClick={() => void decrypt()}>
                {t('fill_form.decrypt_cta')}
              </Button>
            </div>
          </div>
        </div>
      ) : refusalCopy ? (
        <div
          role="status"
          className="mt-4 rounded-lg border border-border-default bg-surface-sunken px-4 py-5 text-center"
        >
          <p className="font-bold">{refusalCopy.title}</p>
          <p className="mt-1.5 text-[13.5px] text-text-muted">{refusalCopy.desc}</p>
        </div>
      ) : ready ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(280px,340px)_1fr]">
          {/* Left: all form fields grouped by page (phase 6b scope) */}
          <section aria-label={t('fill_form.fields_all_title', { count: inspect!.fields.length })}>
            <p className="text-sm font-bold" data-testid="fields-title">
              {t('fill_form.fields_all_title', { count: inspect!.fields.length })}
            </p>
            {signed ? (
              <div
                role="alert"
                data-testid="signed-warning"
                className="mt-2 flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning"
              >
                <span aria-hidden>⚠</span>
                <div>
                  <strong className="block">{t('fill_form.signed_warn_title')}</strong>
                  <span className="block">{t('fill_form.signed_warn_desc')}</span>
                </div>
              </div>
            ) : null}
            {skipped.length > 0 ? (
              <p
                role="status"
                data-testid="skipped-notice"
                className="mt-2 rounded-lg border border-warning bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning"
              >
                {t('fill_form.skipped_notice', { count: skipped.length, names: skipped.join(', ') })}
              </p>
            ) : null}
            <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
              <div className="mt-2 flex max-h-[560px] flex-col gap-4 overflow-y-auto pr-0.5">
                {groups.map(([page, fields]) => (
                  <div key={page}>
                    <p className="text-[12.5px] font-semibold uppercase tracking-wide text-text-muted">
                      {page > 0 ? t('fill_form.page_group', { n: page }) : t('fill_form.page_unknown')}
                    </p>
                    <ul className="mt-1.5 flex flex-col gap-2">
                      {fields.map((f) => (
                        <li key={f.name} className="rounded-lg border border-border-default p-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className="min-w-0 truncate text-[13.5px] font-semibold"
                              title={f.name}
                            >
                              {f.label || f.name}
                            </span>
                            {f.required ? (
                              <span className="rounded border border-warning bg-warning-soft px-1.5 py-0.5 text-[10.5px] font-bold uppercase text-warning">
                                {t('fill_form.badge_required')}
                              </span>
                            ) : null}
                            {f.readOnly ? (
                              <span className="inline-flex items-center gap-1 rounded border border-border-default bg-surface-sunken px-1.5 py-0.5 text-[10.5px] font-bold uppercase text-text-muted">
                                <LockIcon size={10} />
                                {t('fill_form.badge_readonly')}
                              </span>
                            ) : null}
                            {f.multiline ? (
                              <span className="rounded border border-border-strong px-1.5 py-0.5 text-[10.5px] font-bold uppercase text-text-muted">
                                {t('fill_form.badge_multiline')}
                              </span>
                            ) : null}
                            {TYPE_BADGE_KEY[f.type] ? (
                              <span
                                data-testid={`badge-${f.type}`}
                                className="rounded border border-border-strong px-1.5 py-0.5 text-[10.5px] font-bold uppercase text-text-muted"
                              >
                                {t(TYPE_BADGE_KEY[f.type]!)}
                              </span>
                            ) : null}
                          </div>
                          {fieldControl(f)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </form>
          </section>

          {/* Right: page preview + thumbnail strip to jump pages */}
          <section aria-label={t('fill_form.preview_aria')}>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
              >
                {t('fill_form.page_prev')}
              </Button>
              <span className="text-[13px] text-text-muted tabular-nums">
                {t('fill_form.page_of', { n: currentPage, total: numPages })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
                disabled={currentPage >= numPages}
              >
                {t('fill_form.page_next')}
              </Button>
              <span className="ml-auto hidden text-[13px] text-text-muted lg:inline">
                {t('fill_form.preview_hint')}
              </span>
            </div>
            <div className="mt-2 overflow-hidden rounded-lg border border-border-default bg-surface-sunken">
              <canvas ref={previewCanvasRef} className="block h-auto w-full" />
            </div>
            <div className="mt-3">
              <ThumbnailStrip
                pages={Array.from({ length: numPages }, (_, i) => ({
                  key: `p${i + 1}`,
                  pageNumber: i + 1,
                  url: urlFor(`p${i + 1}`),
                  selected: i + 1 === currentPage,
                }))}
                fullscreenTitle={(n) => t('fill_form.fs_title', { n })}
                closeLabel={t('fill_form.fs_close')}
                register={observe}
                onToggle={(pageNumber: number) => setCurrentPage(pageNumber)}
              />
            </div>
          </section>
        </div>
      ) : null}

      {/* Flatten confirm — irreversible bake; HARD signed warning (R15) */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title={t('fill_form.flatten_confirm_title')}>
        <p className="text-[13.5px]">{t('fill_form.flatten_confirm_desc')}</p>
        {signed ? (
          <p
            role="alert"
            data-testid="flatten-signed-warning"
            className="mt-3 rounded-lg border border-warning bg-warning-soft px-3.5 py-2.5 text-[13px] font-semibold text-warning"
          >
            {t('fill_form.flatten_signed_hard_warn')}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
            {t('fill_form.flatten_cancel')}
          </Button>
          <Button
            onClick={() => {
              setConfirmOpen(false);
              void run(pendingDestRef.current);
            }}
          >
            {t('fill_form.flatten_confirm_cta')}
          </Button>
        </div>
      </Dialog>
    </WorkspaceShell>
  );
}

// token-mapped
