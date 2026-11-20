import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BUILDER_SLUGS,
  type BuilderSlug,
  type ChainStep,
} from '../../lib/custom-preset-adapter';
import {
  newCustomPreset,
  savePreset,
  importPresets,
  exportPresets,
  PresetValidationError,
  type CustomPreset,
  type CustomStep,
} from '../../lib/personal-presets';
import { deliverBytes } from '../../lib/download';
import { XIcon } from '../ui/icons';

/*
 * Preset builder modal (v0.13.0 phase 3 — the phase-7 gap): create/edit/
 * clone/import/export personal chains over the tested schema-v2 lib.
 * v1 rules enforced here (the runtime cannot): min 2 steps, NO repeated
 * slug per chain (slug-keyed prefill is not per-step), per-slug option
 * editors for the 5 configurable slugs (merge carries none). Store writes
 * go ONLY through savePreset/importPresets (validation + quarantine live
 * there); the builder never serializes bytes/passwords.
 */

const STEP_OPTIONS_VERSION = 1;

interface BuilderError {
  key: string;
  values?: Record<string, string | number>;
}

export function PresetBuilder({
  open,
  onClose,
  onSaved,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** Present = edit/clone an existing preset (steps preloaded). */
  editing: CustomPreset | null;
}) {
  const { t } = useTranslation(['common', 'tools']);
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<ChainStep[]>([]);
  const [error, setError] = useState<BuilderError | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadedIdRef = useRef<string | null>(null);

  // Load `editing` EXACTLY once per open identity (the user may save and
  // reopen; a stale draft must not overwrite a fresh form).
  if (open && editing && loadedIdRef.current !== editing.id) {
    loadedIdRef.current = editing.id;
    setName(editing.name);
    setSteps(editing.steps.map((s) => ({ slug: s.operationId, options: { ...s.options } })));
  }
  if (!open && loadedIdRef.current !== null) {
    loadedIdRef.current = null;
    setName('');
    setSteps([]);
    setError(null);
    setImportNote(null);
  }

  const remaining = useMemo(
    () => BUILDER_SLUGS.filter((slug) => !steps.some((s) => s.slug === slug)),
    [steps],
  );

  const save = () => {
    setError(null);
    if (steps.length < 2) {
      setError({ key: 'pbuilder.need_two_steps' });
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError({ key: 'pbuilder.need_name' });
      return;
    }
    // v1 no-repeat rule: one slug per chain (runtime prefill is slug-keyed).
    const seen = new Set<string>();
    for (const s of steps) {
      if (seen.has(s.slug)) {
        setError({ key: 'pbuilder.duplicate_slug' });
        return;
      }
      seen.add(s.slug);
    }
    const now = Date.now();
    const base: CustomPreset = editing
      ? { ...editing, name: trimmed, updatedAt: now }
      : { ...newCustomPreset(trimmed), updatedAt: now };
    const preset: CustomPreset = {
      ...base,
      steps: steps.map((s, i): CustomStep => ({
        stepId: `s${i + 1}`,
        operationId: s.slug,
        operationVersion: STEP_OPTIONS_VERSION,
        options: s.options,
      })),
    };
    try {
      savePreset(preset);
    } catch (e) {
      setError({
        key: e instanceof PresetValidationError ? 'pbuilder.save_invalid' : 'pbuilder.save_error',
        values: { message: e instanceof Error ? e.message : String(e) },
      });
      return;
    }
    onSaved();
    onClose();
  };

  const doImport = async (file: File) => {
    setImportNote(null);
    try {
      const text = await file.text();
      const imported = importPresets(text);
      setImportNote(t('pbuilder.import_ok', { count: imported.length }));
      onSaved();
    } catch (e) {
      setImportNote(
        t('pbuilder.import_error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  const doExport = () => {
    // Export rides the standard single-file seam (web download / desktop
    // Save-As) — one JSON artifact of the whole custom store.
    void deliverBytes(
      new TextEncoder().encode(exportPresets()),
      'pdftoolkit-chains.json',
      'download',
      'application/json',
    );
  };

  if (!open) return null;
  const slugTitle = (slug: string) => t(`tools:${slug}.title`);

  const setStepOptions = (idx: number, options: Record<string, unknown>) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, options } : s)));
  };
  const move = (idx: number, delta: -1 | 1) => {
    setSteps((prev) => {
      const next = [...prev];
      const j = idx + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j]!, next[idx]!];
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={editing ? t('pbuilder.title_edit') : t('pbuilder.title')}
        data-testid="preset-builder"
        className="w-full max-w-2xl rounded-2xl border border-border-default bg-surface-card p-5"
      >
        <div className="flex items-center gap-3">
          <h2 className="text-[16px] font-bold">
            {editing ? t('pbuilder.title_edit') : t('pbuilder.title')}
          </h2>
          <span className="flex-1" />
          <button
            type="button"
            aria-label={t('pbuilder.cancel')}
            onClick={onClose}
            className="grid min-h-9 min-w-9 place-items-center rounded-lg text-text-muted hover:bg-surface-hover hover:text-text-primary"
          >
            <XIcon size={15} />
          </button>
        </div>
        <p className="mt-1 text-[13px] text-text-muted">{t('pbuilder.subtitle')}</p>

        <label className="mt-4 flex flex-col gap-1.5 text-[13.5px]">
          <span className="font-semibold">{t('pbuilder.name_label')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('pbuilder.name_placeholder')}
            maxLength={80}
            className="min-h-11 rounded-lg border border-border-strong bg-surface-page px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </label>

        <div className="mt-4">
          <h3 className="text-sm font-bold">{t('pbuilder.steps_label')}</h3>
          {steps.length === 0 ? (
            <p className="mt-1.5 text-[13px] text-text-muted">{t('pbuilder.empty')}</p>
          ) : (
            <ol className="mt-2 flex flex-col gap-2" data-testid="builder-steps">
              {steps.map((step, idx) => (
                <li
                  key={`${step.slug}-${idx}`}
                  data-testid="builder-step"
                  className="rounded-xl border border-border-default px-3.5 py-2.5"
                >
                  <div className="flex items-center gap-2 text-[13.5px]">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent-soft text-xs font-bold tabular-nums">
                      {idx + 1}
                    </span>
                    <span className="font-semibold">{slugTitle(step.slug)}</span>
                    <span className="flex-1" />
                    <button
                      type="button"
                      aria-label={t('pbuilder.move_up')}
                      disabled={idx === 0}
                      onClick={() => move(idx, -1)}
                      className="min-h-8 min-w-8 rounded-lg px-1 text-text-muted disabled:opacity-40 hover:bg-surface-hover"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={t('pbuilder.move_down')}
                      disabled={idx === steps.length - 1}
                      onClick={() => move(idx, 1)}
                      className="min-h-8 min-w-8 rounded-lg px-1 text-text-muted disabled:opacity-40 hover:bg-surface-hover"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={t('pbuilder.remove_step')}
                      onClick={() => setSteps((prev) => prev.filter((_, i) => i !== idx))}
                      className="min-h-8 min-w-8 rounded-lg px-1 text-text-muted hover:text-danger"
                    >
                      ✕
                    </button>
                  </div>
                  <StepOptionsEditor slug={step.slug} options={step.options} onChange={(o) => setStepOptions(idx, o)} />
                </li>
              ))}
            </ol>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <select
              aria-label={t('pbuilder.add_step')}
              data-testid="builder-add-select"
              value=""
              onChange={(e) => {
                const slug = e.target.value as BuilderSlug;
                if (slug) setSteps((prev) => [...prev, { slug, options: {} }]);
              }}
              className="min-h-10 rounded-lg border border-border-strong bg-surface-card px-3 text-[13px]"
            >
              <option value="">{t('pbuilder.add_step')}</option>
              {remaining.map((slug) => (
                <option key={slug} value={slug}>
                  {slugTitle(slug)}
                </option>
              ))}
            </select>
            <span className="text-[12px] text-text-muted">{t('pbuilder.one_slug_note')}</span>
          </div>
        </div>

        {error ? (
          <p role="alert" data-testid="builder-error" className="mt-3 text-[13px] text-danger">
            {t(error.key, error.values)}
          </p>
        ) : null}
        {importNote ? (
          <p role="status" data-testid="builder-import-note" className="mt-3 text-[13px]">
            {importNote}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="builder-save"
            onClick={save}
            className="inline-flex min-h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-text-on-accent hover:opacity-90"
          >
            {editing ? t('pbuilder.update') : t('pbuilder.save')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-10 rounded-lg border border-border-strong px-3.5 text-sm text-text-muted hover:bg-surface-hover"
          >
            {t('pbuilder.cancel')}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="min-h-10 rounded-lg border border-border-strong px-3.5 text-sm text-text-muted hover:bg-surface-hover"
          >
            {t('pbuilder.import')}
          </button>
          <button
            type="button"
            onClick={doExport}
            className="min-h-10 rounded-lg border border-border-strong px-3.5 text-sm text-text-muted hover:bg-surface-hover"
          >
            {t('pbuilder.export')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-hidden="true"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void doImport(f);
              e.target.value = '';
            }}
          />
        </div>
      </section>
    </div>
  );
}

/** Per-slug option editor (the 5 configurable slugs; merge renders none). */
function StepOptionsEditor({
  slug,
  options,
  onChange,
}: {
  slug: string;
  options: Record<string, unknown>;
  onChange: (options: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation(['common', 'tools']);
  if (slug === 'merge') return null;
  if (slug === 'compress') {
    const mode = (options.mode as string) ?? 'vector';
    return (
      <label className="mt-2 flex items-center gap-2 text-[13px]">
        <span className="text-text-muted">{t('pbuilder.opt_compress_mode')}</span>
        <select
          aria-label={t('pbuilder.opt_compress_mode')}
          value={mode}
          onChange={(e) => onChange({ ...options, mode: e.target.value })}
          className="min-h-9 rounded-lg border border-border-strong bg-surface-page px-2 text-[13px]"
        >
          <option value="vector">{t('compress.mode_vector')}</option>
          <option value="image">{t('compress.mode_image')}</option>
          <option value="linearize">{t('compress.mode_linearize')}</option>
        </select>
      </label>
    );
  }
  if (slug === 'watermark') {
    const text = (options.text as string) ?? '';
    return (
      <label className="mt-2 flex items-center gap-2 text-[13px]">
        <span className="text-text-muted">{t('pbuilder.opt_watermark_text')}</span>
        <input
          value={text}
          maxLength={60}
          onChange={(e) => onChange({ ...options, text: e.target.value })}
          className="min-h-9 flex-1 rounded-lg border border-border-strong bg-surface-page px-2 text-[13px]"
        />
      </label>
    );
  }
  if (slug === 'page-numbers') {
    const preset = String((options.preset as number) ?? 0);
    return (
      <label className="mt-2 flex items-center gap-2 text-[13px]">
        <span className="text-text-muted">{t('pbuilder.opt_pn_preset')}</span>
        <select
          aria-label={t('pbuilder.opt_pn_preset')}
          value={preset}
          onChange={(e) => onChange({ ...options, preset: Number(e.target.value) })}
          className="min-h-9 rounded-lg border border-border-strong bg-surface-page px-2 text-[13px]"
        >
          <option value="0">{t('page-numbers.preset1')}</option>
          <option value="1">{t('page-numbers.preset2')}</option>
          <option value="2">{t('page-numbers.preset3')}</option>
          <option value="3">{t('page-numbers.preset4')}</option>
        </select>
      </label>
    );
  }
  if (slug === 'ocr') {
    // Chainable OCR = tesseract + searchable PDF, fixed (AI engines export
    // text/markdown and would dead-end the chain).
    return (
      <p className="mt-1.5 text-[12.5px] text-text-muted">{t('pbuilder.opt_ocr_fixed')}</p>
    );
  }
  if (slug === 'encrypt') {
    const mode = (options.mode as string) ?? 'encrypt';
    return (
      <label className="mt-2 flex items-center gap-2 text-[13px]">
        <span className="text-text-muted">{t('pbuilder.opt_encrypt_mode')}</span>
        <select
          aria-label={t('pbuilder.opt_encrypt_mode')}
          value={mode}
          onChange={(e) => onChange({ ...options, mode: e.target.value })}
          className="min-h-9 rounded-lg border border-border-strong bg-surface-page px-2 text-[13px]"
        >
          <option value="encrypt">{t('encrypt.tab_encrypt')}</option>
          <option value="decrypt">{t('encrypt.tab_decrypt')}</option>
        </select>
      </label>
    );
  }
  return null;
}

// token-mapped
