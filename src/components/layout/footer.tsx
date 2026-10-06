import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

export function Footer() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const replayTour = () => {
    try {
      localStorage.setItem('pdftoolkit-tour-replay', '1');
      localStorage.removeItem('pdftoolkit-tour-done');
    } catch {
      /* storage unavailable */
    }
    if (location.pathname !== '/') navigate('/');
  };
  return (
    <footer className="mt-13 flex flex-wrap gap-4 border-t border-border-default pt-5 text-[13px] text-text-muted">
      <span>{t('footer.note')}</span>
      <button
        type="button"
        className="ml-auto min-h-9 rounded-lg border border-border-strong px-3 hover:bg-surface-hover hover:text-text-primary"
        onClick={replayTour}
      >
        {t('footer.replay_tour')}
      </button>
    </footer>
  );
}

// token-mapped
