/*
 * Page-numbers preset → engine-options mapping (v0.13.0 phase 4): the
 * SINGLE source of truth shared by the tool UI and the queue adapter (RT
 * finding 8 — the mapping used to live scattered in the tool). PURE — the
 * `t` callback resolves the one locale-keyed template; everything else is
 * locale-invariant. GridPos9 stays a structural literal (no engine import —
 * position is one of the 9 well-known strings).
 */

export type PageNumbersPreset = 0 | 1 | 2 | 3;

export interface PageNumbersPresetConfig {
  template: string;
  position: 'top-left' | 'top-center' | 'top-right' | 'middle-left' | 'center' | 'middle-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  margin: number;
  fontSize: number;
  startNumber: number;
  /** skip-first (preset 3): the tool/adapter seeds the scope to 2..N. */
  skipFirst: boolean;
}

/** The tool's default panel preset (RT finding 8: 0, not 1). */
export const PAGE_NUMBERS_DEFAULT_PRESET: PageNumbersPreset = 0;

export function presetConfig(
  preset: PageNumbersPreset,
  t: (key: string) => string,
): PageNumbersPresetConfig {
  const base = {
    position: 'bottom-center' as const,
    margin: 36,
    fontSize: 12,
    startNumber: 1,
    skipFirst: false,
  };
  if (preset === 1) return { ...base, template: '{n}/{total}' };
  if (preset === 2) return { ...base, template: t('page-numbers.preset3_template') };
  if (preset === 3) return { ...base, template: '{n}/{total}', skipFirst: true };
  return { ...base, template: '{n}' };
}

/** Scope for the config: all pages, or 2..N when skipFirst. */
export function presetScope(numPages: number, config: PageNumbersPresetConfig): number[] {
  const first = config.skipFirst ? 2 : 1;
  const out: number[] = [];
  for (let p = first; p <= numPages; p += 1) out.push(p);
  return out;
}

// token-mapped
