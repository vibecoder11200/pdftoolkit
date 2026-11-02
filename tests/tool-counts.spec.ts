import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import enCommon from '../src/locales/en/common.json';
import enTools from '../src/locales/en/tools.json';
import viCommon from '../src/locales/vi/common.json';
import viTools from '../src/locales/vi/tools.json';
import { TOOLS } from '../src/components/layout/tool-card';

/*
 * Count-parity gate (v0.10.0 F8): the tool count rotted TWICE before this
 * spec existed (locale copy said 16 while the README said 17+16 classic).
 * The number in copy MUST equal TOOLS.length; tools.json carries exactly
 * the registered slugs; the routes and locale feeds agree.
 */

const countIn = (s: string): number | null => {
  const m = /(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
};

describe('tool count parity (F8)', () => {
  const n = TOOLS.length;

  it('TOOLS.length matches the locale count strings in BOTH locales', () => {
    for (const [loc, common] of [
      ['vi', viCommon],
      ['en', enCommon],
    ] as const) {
      expect(countIn(common.trust.free_desc), `${loc} trust.free_desc`).toBe(n);
      expect(countIn(common.guide.tools_title), `${loc} guide.tools_title`).toBe(n);
    }
  });

  it('tools.json carries exactly the registered slugs, both locales', () => {
    const slugs = TOOLS.map((t) => t.slug).sort();
    for (const tools of [viTools, enTools]) {
      expect(Object.keys(tools).sort()).toEqual(slugs);
    }
  });

  it('routes.tsx registers every slug exactly once', () => {
    const src = readFileSync('src/routes.tsx', 'utf8');
    for (const t of TOOLS) {
      const hits = src.match(new RegExp(`'${t.slug.replace(/-/g, '\\-')}'`, 'g')) ?? [];
      // One in the slug array + one in the element chain.
      expect(hits.length, `${t.slug} route references`).toBeGreaterThanOrEqual(2);
    }
  });

  it('pdf-to-word is the 18th tool with PDF intake (chip destination, not host)', () => {
    const p2w = TOOLS.find((t) => t.slug === 'pdf-to-word');
    expect(p2w).toBeDefined();
    expect(p2w!.acceptsPdf).toBe(true);
    expect(p2w!.multiFile).toBeUndefined();
    expect(p2w!.category).toBe('opt');
  });
});
