import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { HomeGrid } from '../components/layout/home-grid';
import type { ToolCategory } from '../components/layout/tool-card';
import { Button } from '../components/ui/button';

export function HomePage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<'all' | ToolCategory>('all');

  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <section className="-mx-7 border-b border-slate-200 px-7 pt-15 pb-10 text-center">
          <h1 className="mx-auto max-w-3xl text-3xl font-extrabold text-balance sm:text-4xl">
            {t('hero.title')}
          </h1>
          <p className="mx-auto mt-3 max-w-[62ch] text-base text-slate-500">{t('hero.subtitle')}</p>
          <div className="mt-5.5 flex flex-wrap justify-center gap-3">
            <Button>{t('hero.cta_primary')}</Button>
            <Button variant="secondary">{t('hero.cta_secondary')}</Button>
          </div>
          <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs text-slate-500">
            {[t('hero.badge_no_account'), t('hero.badge_offline'), t('hero.badge_opensource')].map(
              (b) => (
                <span key={b} className="rounded-full border border-slate-200 bg-white px-3 py-1.5">
                  {b}
                </span>
              ),
            )}
          </div>
        </section>
        <HomeGrid filter={filter} onFilter={setFilter} />
        <section className="mt-10 grid grid-cols-1 gap-3.5 md:grid-cols-3" aria-label="trust">
          {(['local', 'offline', 'free'] as const).map((k) => (
            <div key={k} className="rounded-2xl border border-slate-200 bg-white p-4.5">
              <strong className="block text-sm">{t(`trust.${k}_title`)}</strong>
              <span className="text-[13.5px] text-slate-500">{t(`trust.${k}_desc`)}</span>
            </div>
          ))}
        </section>
      </main>
      <Footer />
    </div>
  );
}
