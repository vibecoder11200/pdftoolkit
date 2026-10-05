import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { Logo } from '../ui/logo';
import { ThemeToggle } from '../ui/theme-toggle';

const NAV = [
  { to: '/tools/merge', vi: 'GỘP PDF', en: 'MERGE PDF' },
  { to: '/tools/split', vi: 'TÁCH PDF', en: 'SPLIT PDF' },
  { to: '/tools/compress', vi: 'NÉN PDF', en: 'COMPRESS PDF' },
  { to: '/tools/convert', vi: 'ĐỔI ĐỊNH DẠNG', en: 'CONVERT' },
  { to: '/', vi: 'TẤT CẢ CÔNG CỤ', en: 'ALL TOOLS' },
];

export function Nav() {
  const { t, i18n } = useTranslation();
  const lng = i18n.resolvedLanguage ?? 'vi';

  return (
    <header className="flex h-16 items-center gap-2.5">
      <NavLink to="/" className="flex items-center gap-2.5 p-2 text-[17px] font-extrabold" aria-label={t('a11y.logo')}>
        <Logo />
        PDF Toolkit
      </NavLink>
      <nav aria-label={lng === 'vi' ? 'Chính' : 'Primary'} className="ml-5 hidden gap-0.5 lg:flex">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className="rounded-lg px-2.5 py-2 text-[13.5px] font-semibold tracking-wide text-text-muted hover:bg-surface-hover hover:text-text-primary"
          >
            {lng === 'vi' ? item.vi : item.en}
          </NavLink>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2.5">
        <span className="hidden items-center gap-1.5 rounded-full border border-success bg-success-soft px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-success sm:inline-flex">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
            <rect x="4" y="10" width="16" height="11" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
          {t('topbar.privacy')}
        </span>
        <ThemeToggle />
        <div className="flex overflow-hidden rounded-lg border border-border-strong" role="group" aria-label="Language">
          {(['vi', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={lng === l}
              onClick={() => void i18n.changeLanguage(l)}
              className={`min-h-10 min-w-11 px-3.5 text-[13px] font-semibold ${
                lng === l ? 'bg-surface-inverse text-text-inverse' : 'bg-surface-card text-text-muted'
              }`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

// token-mapped
