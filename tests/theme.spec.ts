// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyResolvedTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  type Theme,
} from '../src/theme/theme';

describe('resolveTheme', () => {
  it.each([
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ] as [Theme, boolean, 'light' | 'dark'][])(
    'resolves %s with systemDark=%j to %s',
    (theme, systemDark, expected) => {
      expect(resolveTheme(theme, systemDark)).toBe(expected);
    },
  );
});

describe('readStoredTheme / storeTheme roundtrip', () => {
  afterEach(() => localStorage.clear());

  it('defaults to system when nothing stored', () => {
    expect(readStoredTheme()).toBe('system');
  });

  it('roundtrips light and dark', () => {
    storeTheme('dark');
    expect(readStoredTheme()).toBe('dark');
    storeTheme('light');
    expect(readStoredTheme()).toBe('light');
  });

  it('treats unknown values as system', () => {
    localStorage.setItem('pdftoolkit-theme', 'sepia');
    expect(readStoredTheme()).toBe('system');
  });

  it('falls back to system when storage throws', () => {
    const throwing: Pick<Storage, 'getItem'> = {
      getItem: () => {
        throw new Error('denied');
      },
    };
    expect(readStoredTheme(throwing)).toBe('system');
  });
});

describe('applyResolvedTheme', () => {
  it('sets data-theme and color-scheme on <html>', () => {
    applyResolvedTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    applyResolvedTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});
