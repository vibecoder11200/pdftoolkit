import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';
import viCommon from './locales/vi/common.json';

// Honor the user's in-app language choice across reloads: changeLanguage
// caches 'i18nextLng' via the detector, but a hardcoded `lng: 'vi'` overrode
// the stored value at every init — EN users were reset to VI on every reload
// (UX audit F4). 'vi' stays the default for first-time visitors.
function readStoredLng(): string | null {
  try {
    return globalThis.localStorage?.getItem('i18nextLng');
  } catch {
    return null;
  }
}

void i18n
  .use(resourcesToBackend((lng: string, ns: string) => import(`./locales/${lng}/${ns}.json`)))
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { vi: { common: viCommon } },
    lng: readStoredLng() === 'en' ? 'en' : 'vi',
    fallbackLng: 'en',
    ns: ['common'],
    defaultNS: 'common',
    partialBundledLanguages: true,
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: true },
  });

export default i18n;
