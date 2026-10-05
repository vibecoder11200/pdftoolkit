import { useTranslation } from 'react-i18next';
import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { ReorderTool } from '../components/workspace/reorder-tool';

export function ReorderToolPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <ReorderTool />
        <p className="mt-4 text-[13px] text-text-muted">{t('footer.note')}</p>
      </main>
      <Footer />
    </div>
  );
}

// token-mapped
