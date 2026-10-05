import { useTranslation } from 'react-i18next';

export function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="mt-13 flex flex-wrap gap-4 border-t border-border-default pt-5 text-[13px] text-text-muted">
      <span>{t('footer.note')}</span>
    </footer>
  );
}

// token-mapped
