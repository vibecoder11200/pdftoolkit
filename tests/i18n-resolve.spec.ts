import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import enCommon from '../src/locales/en/common.json';
import enTools from '../src/locales/en/tools.json';
import viCommon from '../src/locales/vi/common.json';
import viTools from '../src/locales/vi/tools.json';

/*
 * Locale resolution gate (born from the v0.8.1 production bug where the
 * watermark removal UI shipped rendering raw keys): every bare `t('ns.key')`
 * literal in src/ must resolve in the COMMON namespace — the only ns that is
 * eagerly bundled. Declaring extra namespaces via useTranslation(['common',
 * 'tools']) does NOT make their keys reachable for bare t() lookups with the
 * lazy resourcesToBackend (observed live: chunk fetched 200, key still raw),
 * so tools.json must stay a title/desc-only grid feed.
 */

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];
const FILE_EXT_LIKE = /\.(pdf|js|ts|tsx|css|html|png|jpe?g|json|wasm)$/i;
// Discriminant-only literals: never passed to t() as-is (rendered forms use
// e.g. settings.gpu_adapter_software). Extend ONLY with a comment why.
const ALLOWED_NON_RENDER_KEYS = new Set(['settings.gpu_adapter']);

function flatten(obj: Record<string, unknown>, prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') {
      for (const p of flatten(v as Record<string, unknown>, path)) out.add(p);
    } else {
      out.add(path);
    }
  }
  return out;
}

function resolves(key: string, keySet: Set<string>): boolean {
  if (keySet.has(key)) return true;
  return PLURAL_SUFFIXES.some((s) => keySet.has(`${key}${s}`));
}

function collectSourceKeys(): Map<string, string[]> {
  const files = execSync('git ls-files src', { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((f) => /\.[jt]sx?$/.test(f));
  const hits = new Map<string, string[]>();
  // t('a.b') / t("a.b") call literals (also matches i18n.t(...)), plus
  // `key: 'a.b'` object fields (splitErrorKey-style deferred t(key)).
  const patterns = [/\bt\(\s*(['"])([a-z][\w]*(?:\.[a-z][\w]*)+)\1/g, /\bkey:\s*(['"])([a-z][\w]*(?:\.[a-z][\w]*)+)\1/g];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const seen = new Set<string>();
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const key = m[2];
        if (!key.includes('.') || FILE_EXT_LIKE.test(key)) continue;
        seen.add(key);
      }
    }
    if (seen.size > 0) hits.set(file, [...seen].sort());
  }
  return hits;
}

const viKeySet = flatten(viCommon as Record<string, unknown>);

describe('i18n resolution gate (v0.8.1 raw-key regression)', () => {
  it('every bare t()/key literal in src resolves in vi common.json', () => {
    const hits = collectSourceKeys();
    const missing: string[] = [];
    for (const [file, keys] of hits) {
      for (const key of keys) {
        if (ALLOWED_NON_RENDER_KEYS.has(key)) continue;
        if (!resolves(key, viKeySet)) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing, `keys that would render raw:\n${missing.join('\n')}`).toEqual([]);
  });

  it('vi and en common.json have identical key sets', () => {
    const vi = flatten(viCommon as Record<string, unknown>);
    const en = flatten(enCommon as Record<string, unknown>);
    expect([...vi].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !vi.has(k))).toEqual([]);
  });

  it('tools.json is a title/desc-only grid feed in both locales', () => {
    for (const [name, tools] of [
      ['vi', viTools],
      ['en', enTools],
    ] as const) {
      for (const [slug, section] of Object.entries(tools)) {
        expect(Object.keys(section as object).sort(), `${name}/${slug}`).toEqual(['desc', 'title']);
      }
    }
    expect(Object.keys(viTools)).toEqual(Object.keys(enTools));
  });
});
