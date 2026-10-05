import { useTranslation } from 'react-i18next';
import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { MergeTool } from '../components/workspace/merge-tool';

export function MergeToolPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <MergeTool />
        <p className="mt-4 text-[13px] text-slate-500">{t('footer.note')}</p>
      </main>
      <Footer />
    </div>
  );
}
