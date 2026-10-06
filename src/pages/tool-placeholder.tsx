import { useTranslation } from 'react-i18next';
import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { EmptyState } from '../components/ui/empty-state';
import { FileIcon } from '../components/ui/icons';

/** Explicit "under development" page for nav entries awaiting a tool
 * (currently /tools/convert) — replaces the silent catch-all redirect. */
export function ComingSoonPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main className="mt-8 rounded-2xl border border-border-default bg-surface-card">
        <EmptyState
          muted
          icon={<FileIcon size={34} />}
          title={t('coming_soon.title')}
          hint={t('coming_soon.hint')}
          action={
            <span className="rounded-full border border-border-strong px-3 py-1 text-xs font-semibold text-text-muted">
              {t('coming_soon.badge')}
            </span>
          }
        />
      </main>
      <Footer />
    </div>
  );
}
