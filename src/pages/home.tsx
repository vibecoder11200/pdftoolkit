import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { HomeGrid } from '../components/layout/home-grid';
import { GlobalDrop } from '../components/layout/global-drop';
import { SuggestionSheet, type SheetState } from '../components/layout/suggestion-sheet';
import type { ToolCategory } from '../components/layout/tool-card';
import { Dropzone } from '../components/ui/dropzone';
import { GuideWelcome } from '../components/layout/quick-guide';
import { buildSuggestions } from '../lib/suggest';
import { clearPendingFiles, onPending } from '../lib/handoff';
import { initShareTarget } from '../lib/share-target';

const HOME_ACCEPT = '.pdf,.jpg,.jpeg,.png';

export function HomePage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<'all' | ToolCategory>('all');
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const handleFiles = useCallback(async (files: File[]) => {
    const result = await buildSuggestions(files);
    setSheet({ files, result });
  }, []);

  // Reactive (not mount-only): pending can appear while the user is already
  // sitting on home — e.g. the PWA file handler in phase 6 — and the sheet
  // must open whenever that happens (red-team #9).
  useEffect(() => onPending((pending) => void handleFiles(pending.files)), [handleFiles]);

  // Android share target always 303s here — home is the only landing page,
  // so the handshake listener is mounted exactly once per session (idempotent).
  useEffect(() => initShareTarget(), []);

  const closeSheet = useCallback(() => {
    clearPendingFiles();
    setSheet(null);
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <section className="-mx-7 border-b border-border-default px-7 pt-15 pb-10 text-center">
          <h1 className="mx-auto max-w-3xl text-3xl font-extrabold text-balance sm:text-4xl">
            {t('hero.title')}
          </h1>
          <p className="mx-auto mt-3 max-w-[62ch] text-base text-text-muted">{t('hero.subtitle')}</p>
          <Dropzone
            title={t('home.hero_drop_title')}
            hint={t('home.hero_drop_hint')}
            accept={HOME_ACCEPT}
            onFiles={(f) => void handleFiles(f)}
            className="mx-auto mt-5.5 w-full max-w-2xl flex-col py-10"
          />
          <GuideWelcome />
          <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs text-text-muted">
            {[t('hero.badge_no_account'), t('hero.badge_offline'), t('hero.badge_opensource')].map(
              (b) => (
                <span key={b} className="rounded-full border border-border-default bg-surface-card px-3 py-1.5">
                  {b}
                </span>
              ),
            )}
          </div>
        </section>
        <HomeGrid filter={filter} onFilter={setFilter} />
        <section className="mt-10 grid grid-cols-1 gap-3.5 md:grid-cols-3" aria-label="trust">
          {(['local', 'offline', 'free'] as const).map((k) => (
            <div key={k} className="rounded-2xl border border-border-default bg-surface-card p-4.5">
              <strong className="block text-sm">{t(`trust.${k}_title`)}</strong>
              <span className="text-[13.5px] text-text-muted">{t(`trust.${k}_desc`)}</span>
            </div>
          ))}
        </section>
      </main>
      <Footer />
      <GlobalDrop onFiles={(f) => void handleFiles(f)} />
      {sheet ? <SuggestionSheet state={sheet} onClose={closeSheet} /> : null}
    </div>
  );
}

// token-mapped
