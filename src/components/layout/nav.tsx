import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useLocation } from 'react-router-dom';
import { Logo } from '../ui/logo';
import { ThemeToggle } from '../ui/theme-toggle';
import { MenuIcon, XIcon } from '../ui/icons';

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
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Route change closes the panel WITHOUT the focus restore: the whole Nav
  // unmounts, so the old hamburger node is gone — restoring to it is a no-op.
  useEffect(() => {
    wasOpen.current = false;
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (menuOpen) {
      wasOpen.current = true;
      return;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      hamburgerRef.current?.focus();
    }
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <header className="relative flex h-16 items-center gap-2.5">
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
        <div className="hidden sm:block">
          <ThemeToggle />
        </div>
        <div className="hidden overflow-hidden rounded-lg border border-border-strong sm:flex" role="group" aria-label="Language">
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
        <button
          ref={hamburgerRef}
          type="button"
          aria-label={menuOpen ? t('a11y.menu_close') : t('a11y.menu')}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav-panel"
          onClick={() => setMenuOpen((o) => !o)}
          className="grid min-h-10 min-w-10 place-items-center rounded-lg text-text-muted hover:bg-surface-hover hover:text-text-primary lg:hidden"
        >
          {menuOpen ? <XIcon size={19} /> : <MenuIcon size={19} />}
        </button>
      </div>
      {menuOpen ? (
        <div
          id="mobile-nav-panel"
          className="absolute top-full right-0 left-0 z-50 flex flex-col gap-1 border-b border-border-default bg-surface-card p-4 shadow-lg lg:hidden"
        >
          <nav aria-label={lng === 'vi' ? 'Chính' : 'Primary'} className="flex flex-col">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className="rounded-lg px-2.5 py-2.5 text-sm font-semibold text-text-muted hover:bg-surface-hover hover:text-text-primary"
              >
                {lng === 'vi' ? item.vi : item.en}
              </NavLink>
            ))}
          </nav>
          <div className="mt-2 flex items-center justify-between border-t border-border-default pt-3">
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
        </div>
      ) : null}
    </header>
  );
}

// token-mapped
