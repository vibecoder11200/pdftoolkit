import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  applyResolvedTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  systemPrefersDark,
  watchSystemTheme,
  type Theme,
} from '../../theme/theme';

const OPTIONS: { value: Theme; labelKey: string; icon: ReactNode }[] = [
  {
    value: 'light',
    labelKey: 'topbar.theme_light',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
      </svg>
    ),
  },
  {
    value: 'dark',
    labelKey: 'topbar.theme_dark',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z" />
      </svg>
    ),
  },
  {
    value: 'system',
    labelKey: 'topbar.theme_system',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="4.5" width="18" height="12.5" rx="2" />
        <path d="M8.5 20.5h7" />
      </svg>
    ),
  },
];

export function ThemeToggle() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    const stored = readStoredTheme();
    setTheme(stored);
    applyResolvedTheme(resolveTheme(stored, systemPrefersDark()));
    // OS scheme flips only matter while the user follows the system.
    return watchSystemTheme((systemDark) => {
      if (readStoredTheme() === 'system') {
        applyResolvedTheme(resolveTheme('system', systemDark));
      }
    });
  }, []);

  const pick = (next: Theme) => {
    storeTheme(next);
    setTheme(next);
    applyResolvedTheme(resolveTheme(next, systemPrefersDark()));
  };

  return (
    <div
      className="flex overflow-hidden rounded-lg border border-border-strong"
      role="group"
      aria-label={t('topbar.theme_toggle')}
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={theme === option.value}
          aria-label={t(option.labelKey)}
          title={t(option.labelKey)}
          onClick={() => pick(option.value)}
          className={`grid h-10 w-10 place-items-center ${
            theme === option.value
              ? 'bg-surface-inverse text-text-inverse'
              : 'text-text-muted hover:bg-surface-hover'
          }`}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}
