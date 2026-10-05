export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'pdftoolkit-theme';

export function readStoredTheme(storage: Pick<Storage, 'getItem'> = localStorage): Theme {
  try {
    const value = storage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode / storage disabled: theme stays session-only.
  }
}

export function systemPrefersDark(mql: MediaQueryList = matchMedia('(prefers-color-scheme: dark)')): boolean {
  return mql.matches;
}

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}

/** Mirrors public/theme-boot.js (runs pre-paint); the app re-applies after hydration. */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

/** Subscribes to OS scheme flips; returns an unsubscribe function. */
export function watchSystemTheme(onChange: (systemDark: boolean) => void): () => void {
  const mql = matchMedia('(prefers-color-scheme: dark)');
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}
