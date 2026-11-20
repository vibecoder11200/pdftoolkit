import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { appendPendingFiles } from '../../lib/handoff';
import { PRESETS } from '../../lib/presets';
import {
  intakeAccept,
  intakeMultiple,
  type PresetIntake,
} from '../../lib/presets';
import {
  deletePreset,
  listPresets,
  clonePreset,
  type CustomPreset,
} from '../../lib/personal-presets';
import { chainFromBuiltin, chainFromCustom, type Chain } from '../../lib/custom-preset-adapter';
import { startPresetSession } from '../../lib/preset-session';
import { TOOLS } from './tool-card';
import { Dropzone } from '../ui/dropzone';
import { PresetBuilder } from '../workspace/preset-builder';

/*
 * Home "Chuỗi nhanh" strip (v0.8.1 phase 4, EXTENDED v0.13.0 phase 3):
 * the four builtin chains, then the user's saved custom chains, then the
 * builder entry card. Click a card → intake dropzone scoped to the chain's
 * accepted type → appendPendingFiles + startPresetSession + navigate to
 * step 1 (mount-take loads the files through the normal validated intake).
 * Files park via appendPendingFiles ONLY (v0.8.0 invariant). Custom cards
 * expose edit/clone/delete in their EXPANDED panel (buttons never nest in
 * the card button); delete is a two-click confirm (no native dialogs).
 */

function entryIcon(slug: string): { icon: string; tone: string } {
  const entry = TOOLS.find((tool) => tool.slug === slug);
  return { icon: entry?.icon ?? '', tone: entry?.tone ?? '' };
}

export function PresetStrip() {
  // ['common', 'tools'] (v0.8.0 invariant): strip copy lives in common; the
  // step chains render tool titles from the lazy tools namespace — declaring
  // it is what loads it, an inline `tools:` prefix alone never does.
  const { t } = useTranslation(['common', 'tools']);
  const navigate = useNavigate();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<CustomPreset | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [storeVersion, setStoreVersion] = useState(0);
  void storeVersion; // re-render tick after store mutations

  // Builtin chains + saved custom chains (adapter-resolved, skipped slugs
  // surface as a count on the card — honest, never a silent drop).
  const chains: { chain: Chain; skipped: number }[] = [
    ...PRESETS.map((p) => ({ chain: chainFromBuiltin(p), skipped: 0 })),
    ...listPresets().flatMap((c) => {
      const outcome = chainFromCustom(c);
      return outcome.chain ? [{ chain: outcome.chain, skipped: outcome.skippedSlugs.length }] : [];
    }),
  ];
  const active = chains.find((c) => c.chain.id === activeId) ?? null;

  const start = (chain: Chain, files: File[]) => {
    if (files.length === 0) return;
    // Entry meta: decrypt-first chains open encrypt in decrypt mode — the
    // mount-take reads this meta exactly like watermark's parkToDecrypt.
    const meta =
      chain.steps[0]?.slug === 'encrypt' && chain.defaults.encrypt?.mode === 'decrypt'
        ? { mode: 'decrypt' as const }
        : undefined;
    appendPendingFiles(files, meta);
    startPresetSession(chain.id);
    navigate(`/tools/${chain.steps[0]!.slug}`);
  };

  const chainLabel = (chain: Chain) =>
    chain.custom ? chain.name : t(`presets.${chain.id}_name`);

  const openBuilder = (preset: CustomPreset | null) => {
    setEditing(preset);
    setBuilderOpen(true);
  };

  return (
    <section className="mt-10" aria-label={t('presets.strip_title')}>
      <h2 className="text-xs font-bold tracking-[0.08em] text-text-muted uppercase">
        {t('presets.strip_title')}
      </h2>
      <p className="mt-1.5 text-[13.5px] text-text-muted">{t('presets.strip_subtitle')}</p>
      <div className="mt-3 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        {chains.map(({ chain, skipped }) => {
          const { icon, tone } = entryIcon(chain.steps[0]!.slug);
          const selected = activeId === chain.id;
          return (
            <button
              key={chain.id}
              type="button"
              aria-pressed={selected}
              data-preset={chain.id}
              data-testid="preset-card"
              onClick={() => setActiveId(selected ? null : chain.id)}
              className={`flex flex-col gap-1 rounded-2xl border-2 p-4 pb-4.5 text-left transition hover:-translate-y-0.5 ${
                selected ? 'border-accent bg-accent-soft' : 'border-border-default bg-surface-card hover:border-accent'
              }`}
            >
              <span className={`grid h-10 w-10 place-items-center rounded-xl ${tone}`} aria-hidden>
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d={icon} />
                </svg>
              </span>
              <span className="mt-2 text-[15px] font-bold">{chainLabel(chain)}</span>
              {chain.custom ? (
                <span className="text-xs font-semibold text-text-muted">{t('pbuilder.custom_tag')}</span>
              ) : (
                <span className="text-[13px] leading-relaxed text-text-muted">
                  {t(`presets.${chain.id}_desc`)}
                </span>
              )}
              <span className="mt-1 text-xs font-semibold text-text-muted">
                {chain.steps.map((step) => t(`tools:${step.slug}.title`)).join(' → ')}
              </span>
              {skipped > 0 ? (
                <span className="text-xs text-warning">{t('pbuilder.skipped_steps', { count: skipped })}</span>
              ) : null}
            </button>
          );
        })}
        <button
          type="button"
          data-testid="preset-create"
          onClick={() => openBuilder(null)}
          className="flex flex-col gap-1 rounded-2xl border-2 border-dashed border-border-strong p-4 pb-4.5 text-left transition hover:-translate-y-0.5 hover:border-accent"
        >
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent-soft text-accent" aria-hidden>
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className="mt-2 text-[15px] font-bold">{t('pbuilder.create_card')}</span>
          <span className="text-[13px] leading-relaxed text-text-muted">
            {t('pbuilder.create_card_hint')}
          </span>
        </button>
      </div>

      {active ? (
        <div className="mt-3.5 flex flex-col gap-2.5">
          {active.chain.custom ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border-default bg-surface-card px-3.5 py-2.5">
              <span className="text-[13.5px] font-semibold">{chainLabel(active.chain)}</span>
              <span className="flex-1" />
              <button
                type="button"
                data-testid="preset-edit"
                onClick={() => {
                  const raw = listPresets().find((p) => p.id === active.chain.id) ?? null;
                  openBuilder(raw);
                }}
                className="min-h-9 rounded-lg border border-border-strong px-3 text-[13px] text-text-muted hover:bg-surface-hover hover:text-text-primary"
              >
                {t('pbuilder.edit')}
              </button>
              <button
                type="button"
                data-testid="preset-clone"
                onClick={() => {
                  const raw = listPresets().find((p) => p.id === active.chain.id);
                  if (!raw) return;
                  clonePreset(raw, `${raw.name} 2`);
                  setStoreVersion((v) => v + 1);
                }}
                className="min-h-9 rounded-lg border border-border-strong px-3 text-[13px] text-text-muted hover:bg-surface-hover hover:text-text-primary"
              >
                {t('pbuilder.clone')}
              </button>
              <button
                type="button"
                data-testid="preset-delete"
                onClick={() => {
                  if (confirmDeleteId !== active.chain.id) {
                    setConfirmDeleteId(active.chain.id);
                    return;
                  }
                  deletePreset(active.chain.id);
                  setConfirmDeleteId(null);
                  setActiveId(null);
                  setStoreVersion((v) => v + 1);
                }}
                className="min-h-9 rounded-lg border border-border-strong px-3 text-[13px] text-text-muted hover:bg-surface-hover hover:text-danger"
              >
                {confirmDeleteId === active.chain.id ? t('pbuilder.delete_confirm') : t('pbuilder.delete')}
              </button>
            </div>
          ) : null}
          <Dropzone
            data-testid="preset-intake"
            title={t(`presets.drop_title_${active.chain.intake}`)}
            hint={t(`presets.drop_hint_${active.chain.intake}`)}
            accept={intakeAccept(active.chain.intake as PresetIntake)}
            multiple={intakeMultiple(active.chain.intake as PresetIntake)}
            className="w-full flex-col py-8"
            onFiles={(files) => start(active.chain, files)}
            footer={
              <button
                type="button"
                onClick={() => setActiveId(null)}
                className="min-h-9 rounded-lg border border-border-strong px-3 text-[13px] text-text-muted hover:bg-surface-hover hover:text-text-primary"
              >
                {t('presets.cancel')}
              </button>
            }
          />
        </div>
      ) : null}
      <PresetBuilder
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        onSaved={() => setStoreVersion((v) => v + 1)}
        editing={editing}
      />
    </section>
  );
}

// token-mapped
