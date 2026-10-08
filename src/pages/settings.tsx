import { useTranslation } from 'react-i18next';
import { Nav } from '../components/layout/nav';
import { Footer } from '../components/layout/footer';
import { StorageManager } from '../components/settings/storage-manager';
import { HardwarePanel } from '../components/settings/hardware-panel';
import { AboutPanel } from '../components/settings/about-panel';

export function SettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-7xl px-7 pb-24">
      <Nav />
      <main>
        <section className="-mx-7 border-b border-border-default px-7 pt-15 pb-8 text-center">
          <h1 className="text-2xl font-extrabold sm:text-3xl">{t('settings.title')}</h1>
        </section>
        <StorageManager />
        <HardwarePanel />
        <AboutPanel />
      </main>
      <Footer />
    </div>
  );
}
