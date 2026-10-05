import { useTranslation } from 'react-i18next';
import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { SplitTool } from '../components/workspace/split-tool';

export function SplitToolPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <SplitTool />
        <p className="mt-4 text-[13px] text-slate-500">{t('footer.note')}</p>
      </main>
      <Footer />
    </div>
  );
}
