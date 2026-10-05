import { useTranslation } from 'react-i18next';
import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';

export function ToolPlaceholderPage({ toolKey }: { toolKey: string }) {
  const { t } = useTranslation('tools');
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main className="mt-8 rounded-2xl border border-border-default bg-surface-card p-11 text-center text-text-muted">
        <strong className="block text-text-primary">{t(`${toolKey}.title`)}</strong>
        <span className="text-sm">{t(`${toolKey}.desc`)}</span>
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
