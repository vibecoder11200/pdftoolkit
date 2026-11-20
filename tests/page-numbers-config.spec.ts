import { describe, expect, it } from 'vitest';
import {
  PAGE_NUMBERS_DEFAULT_PRESET,
  presetConfig,
  presetScope,
} from '../src/lib/page-numbers-config';

/*
 * v0.13.0 phase 4 — the shared preset→options mapping (tool UI + queue
 * adapter single source of truth). Locale-keyed template resolved through
 * the injected t; skip-first scope helper pinned.
 */

const t = (key: string) => (key === 'page-numbers.preset3_template' ? 'Trang {n}/{total}' : key);

describe('presetConfig', () => {
  it('default preset is 0 (RT finding 8 — NOT 1)', () => {
    expect(PAGE_NUMBERS_DEFAULT_PRESET).toBe(0);
  });

  it('preset 0 = plain {n} bottom-center', () => {
    const cfg = presetConfig(0, t);
    expect(cfg).toEqual({
      template: '{n}',
      position: 'bottom-center',
      margin: 36,
      fontSize: 12,
      startNumber: 1,
      skipFirst: false,
    });
  });

  it('preset 1 = {n}/{total}; preset 2 = locale template', () => {
    expect(presetConfig(1, t).template).toBe('{n}/{total}');
    expect(presetConfig(2, t).template).toBe('Trang {n}/{total}');
    expect(presetConfig(2, t).skipFirst).toBe(false);
  });

  it('preset 3 = {n}/{total} WITH skip-first', () => {
    const cfg = presetConfig(3, t);
    expect(cfg.template).toBe('{n}/{total}');
    expect(cfg.skipFirst).toBe(true);
  });
});

describe('presetScope', () => {
  it('all pages when not skip-first', () => {
    expect(presetScope(4, presetConfig(0, t))).toEqual([1, 2, 3, 4]);
  });

  it('2..N when skip-first (1-page doc → empty scope)', () => {
    expect(presetScope(4, presetConfig(3, t))).toEqual([2, 3, 4]);
    expect(presetScope(1, presetConfig(3, t))).toEqual([]);
  });
});
