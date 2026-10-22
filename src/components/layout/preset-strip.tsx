import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { appendPendingFiles } from '../../lib/handoff';
import { PRESETS, intakeAccept, intakeMultiple, type Preset } from '../../lib/presets';
import { startPresetSession } from '../../lib/preset-session';
import { TOOLS } from './tool-card';
import { Dropzone } from '../ui/dropzone';

/*
 * Home "Chuỗi nhanh" strip (v0.8.1 phase 4): the four combo presets. Click
 * a card → an intake dropzone scoped to the preset's accepted type (images
 * for scan-number, PDFs otherwise) → appendPendingFiles + startPresetSession
 * + navigate to step 1, whose existing mount-take loads the files through
 * its normal validated intake. Files park via appendPendingFiles ONLY
 * (v0.8.0 invariant) so a parked OS-launch batch survives the handoff.
 */

export function PresetStrip() {
  // ['common', 'tools'] (v0.8.0 invariant): strip copy lives in common; the
  // step chains render tool titles from the lazy tools namespace — declaring
  // it is what loads it, an inline `tools:` prefix alone never does.
  const { t } = useTranslation(['common', 'tools']);
  const navigate = useNavigate();
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const active = PRESETS.find((p) => p.slug === activeSlug) ?? null;

  const start = (preset: Preset, files: File[]) => {
    if (files.length === 0) return;
    // Entry meta: unlock-merge opens encrypt in decrypt mode — its mount-take
    // reads this meta exactly like watermark's parkToDecrypt handoff does.
    const meta =
      preset.steps[0] === 'encrypt' && preset.defaults.encrypt?.mode === 'decrypt'
        ? { mode: 'decrypt' as const }
        : undefined;
    appendPendingFiles(files, meta);
    startPresetSession(preset.slug);
    navigate(`/tools/${preset.steps[0]}`);
  };

  return (
    <section className="mt-10" aria-label={t('presets.strip_title')}>
      <h2 className="text-xs font-bold tracking-[0.08em] text-text-muted uppercase">
        {t('presets.strip_title')}
      </h2>
      <p className="mt-1.5 text-[13.5px] text-text-muted">{t('presets.strip_subtitle')}</p>
      <div className="mt-3 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        {PRESETS.map((preset) => {
          const entry = TOOLS.find((tool) => tool.slug === preset.steps[0]);
          const selected = activeSlug === preset.slug;
          return (
            <button
              key={preset.slug}
              type="button"
              aria-pressed={selected}
              data-preset={preset.slug}
              onClick={() => setActiveSlug(selected ? null : preset.slug)}
              className={`flex flex-col gap-1 rounded-2xl border-2 p-4 pb-4.5 text-left transition hover:-translate-y-0.5 ${
                selected ? 'border-accent bg-accent-soft' : 'border-border-default bg-surface-card hover:border-accent'
              }`}
            >
              <span className={`grid h-10 w-10 place-items-center rounded-xl ${entry?.tone ?? ''}`} aria-hidden>
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d={entry?.icon ?? ''} />
                </svg>
              </span>
              <span className="mt-2 text-[15px] font-bold">{t(`presets.${preset.slug}_name`)}</span>
              <span className="text-[13px] leading-relaxed text-text-muted">
                {t(`presets.${preset.slug}_desc`)}
              </span>
              <span className="mt-1 text-xs font-semibold text-text-muted">
                {preset.steps.map((slug) => t(`tools:${slug}.title`)).join(' → ')}
              </span>
            </button>
          );
        })}
      </div>
      {active ? (
        <div className="mt-3.5">
          <Dropzone
            data-testid="preset-intake"
            title={t(`presets.drop_title_${active.intake}`)}
            hint={t(`presets.drop_hint_${active.intake}`)}
            accept={intakeAccept(active.intake)}
            multiple={intakeMultiple(active.intake)}
            className="w-full flex-col py-8"
            onFiles={(files) => start(active, files)}
            footer={
              <button
                type="button"
                onClick={() => setActiveSlug(null)}
                className="min-h-9 rounded-lg border border-border-strong px-3 text-[13px] text-text-muted hover:bg-surface-hover hover:text-text-primary"
              >
                {t('presets.cancel')}
              </button>
            }
          />
        </div>
      ) : null}
    </section>
  );
}

// token-mapped
