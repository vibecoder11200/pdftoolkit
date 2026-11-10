import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { EmptyState } from '../components/ui/empty-state';
import { FileIcon } from '../components/ui/icons';

/** Friendly not-found (UX audit F9): an unknown URL used to silently render
 * the home grid — the user never learned the link was broken. */
export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main className="mt-8 rounded-2xl border border-border-default bg-surface-card">
        <EmptyState
          muted
          icon={<FileIcon size={34} />}
          title={t('not_found.title')}
          hint={t('not_found.hint')}
          action={
            <Link
              to="/"
              className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-sm font-bold text-text-on-accent hover:opacity-90"
            >
              {t('not_found.cta')}
            </Link>
          }
        />
      </main>
      <Footer />
    </div>
  );
}
