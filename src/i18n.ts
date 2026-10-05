import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';
import viCommon from './locales/vi/common.json';

void i18n
  .use(resourcesToBackend((lng: string, ns: string) => import(`./locales/${lng}/${ns}.json`)))
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { vi: { common: viCommon } },
    lng: 'vi',
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
