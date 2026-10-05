import { useTranslation } from 'react-i18next';
import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { MetadataTool } from '../components/workspace/metadata-tool';

export function MetadataToolPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <MetadataTool />
        <p className="mt-4 text-[13px] text-slate-500">{t('footer.note')}</p>
      </main>
      <Footer />
    </div>
  );
}
