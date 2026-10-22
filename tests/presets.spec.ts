// @vitest-environment jsdom
// Combo presets (v0.8.1 phase 4): PRESETS shape invariants (every step is a
// real tool; a chained step must actually CONSUME a parked PDF; img-to-pdf
// is entry-only), the preset session store lifecycle (handoff.spec.ts
// pattern: singleton + one-shot semantics + replay-on-subscribe), the
// defaults-for-current-step gate, and vi/en locale parity for the new keys.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRESETS,
  getPreset,
  intakeAccept,
  intakeMultiple,
} from '../src/lib/presets';
import {
  clearPresetSession,
  getPresetSession,
  onPresetSession,
  presetDefaultsFor,
  setPresetStep,
  startPresetSession,
} from '../src/lib/preset-session';
import { TOOLS } from '../src/components/layout/tool-card';
import { appendPendingFiles, pendingFileCount, takePendingFiles } from '../src/lib/handoff';
import enCommon from '../src/locales/en/common.json';
import viCommon from '../src/locales/vi/common.json';

const TOOL_SLUGS = new Set(TOOLS.map((tool) => tool.slug));

afterEach(() => {
  clearPresetSession();
  takePendingFiles(); // drain any handoff a test parked
});

describe('PRESETS shape invariants', () => {
  it('ships exactly the four planned chains with the planned steps', () => {
    expect(PRESETS.map((p) => p.slug)).toEqual([
      'quick-merge-compress',
      'scan-number',
      'stamp-compress',
      'unlock-merge',
    ]);
    expect(PRESETS.map((p) => p.steps)).toEqual([
      ['merge', 'compress'],
      ['img-to-pdf', 'ocr', 'page-numbers'],
      ['watermark', 'compress'],
      ['encrypt', 'merge'],
    ]);
  });

  it('every step slug is a real tool; steps are unique within a chain', () => {
    for (const preset of PRESETS) {
      expect(preset.steps.length).toBeGreaterThanOrEqual(2);
      expect(new Set(preset.steps).size).toBe(preset.steps.length);
      for (const slug of preset.steps) {
        expect(TOOL_SLUGS.has(slug), `${preset.slug}: unknown step ${slug}`).toBe(true);
      }
    }
  });

  it('every LATER step consumes parked PDFs (acceptsPdf, or ocr since phase 4)', () => {
    // A step after the first receives the previous output via
    // appendPendingFiles + mount-take. img-to-pdf REJECTS PDFs at intake, so
    // it can never be a later step; ocr takes pending files since this phase
    // (its acceptsPdf chip flag stays off — the chip picker is unchanged).
    for (const preset of PRESETS) {
      for (const slug of preset.steps.slice(1)) {
        const ok =
          slug === 'ocr' || TOOLS.find((tool) => tool.slug === slug)?.acceptsPdf === true;
        expect(ok, `${preset.slug}: later step ${slug} would leak a parked PDF`).toBe(true);
      }
      expect(preset.steps.slice(1)).not.toContain('img-to-pdf');
    }
  });

  it('a preset never prefills a tool it does not visit', () => {
    for (const preset of PRESETS) {
      for (const toolSlug of Object.keys(preset.defaults)) {
        expect(
          preset.steps.includes(toolSlug),
          `${preset.slug} prefills ${toolSlug} but never visits it`,
        ).toBe(true);
      }
    }
  });

  it('intake maps to dropzone accept + multiple (images mirror img-to-pdf)', () => {
    expect(intakeAccept('pdf-multi')).toBe('application/pdf,.pdf');
    expect(intakeAccept('pdf-single')).toBe('application/pdf,.pdf');
    expect(intakeAccept('image')).toBe('image/jpeg,.jpg,.jpeg,image/png,.png');
    expect(intakeMultiple('pdf-multi')).toBe(true);
    expect(intakeMultiple('image')).toBe(true);
    expect(intakeMultiple('pdf-single')).toBe(false);
  });

  it('presets.ts stays pure data — zero pdf-lib imports (entry chunk guard)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../src/lib/presets.ts'), 'utf8');
    expect(source).not.toMatch(/['"]pdf-lib['"]/);
    expect(source).not.toMatch(/^import\s/m);
  });
});

describe('preset session store lifecycle', () => {
  it('start sets step 0; unknown slugs are ignored', () => {
    expect(getPresetSession()).toBeNull();
    startPresetSession('no-such-preset');
    expect(getPresetSession()).toBeNull();
    startPresetSession('scan-number');
    expect(getPresetSession()).toEqual({ presetSlug: 'scan-number', stepIndex: 0 });
  });

  it('setPresetStep walks forward and clamps to the step range', () => {
    startPresetSession('scan-number'); // 3 steps
    setPresetStep(-3);
    expect(getPresetSession()?.stepIndex).toBe(0);
    setPresetStep(1);
    expect(getPresetSession()?.stepIndex).toBe(1);
    setPresetStep(99);
    expect(getPresetSession()?.stepIndex).toBe(2);
  });

  it('clear empties the session; repeated clears are silent', () => {
    const seen: Array<string | null> = [];
    const off = onPresetSession((s) => seen.push(s?.presetSlug ?? null));
    startPresetSession('stamp-compress');
    clearPresetSession();
    clearPresetSession();
    expect(getPresetSession()).toBeNull();
    off();
    // replay + start + clear (the second clear fires nothing)
    expect(seen).toEqual([null, 'stamp-compress', null]);
  });

  it('onPresetSession replays the current session to new subscribers', () => {
    startPresetSession('quick-merge-compress');
    setPresetStep(1);
    const seen: number[] = [];
    const off = onPresetSession((s) => seen.push(s?.stepIndex ?? -1));
    expect(seen).toEqual([1]);
    off();
  });

  it('listeners can unsubscribe', () => {
    const fn = vi.fn();
    const off = onPresetSession(fn);
    off();
    startPresetSession('unlock-merge');
    expect(fn).toHaveBeenCalledTimes(1); // only the subscribe-time replay
    clearPresetSession();
  });
});

describe('presetDefaultsFor (per-tool prefill gate)', () => {
  it('returns the slice ONLY for the tool the session stands on', () => {
    startPresetSession('scan-number'); // step 0 = img-to-pdf
    expect(presetDefaultsFor('page-numbers')).toBeUndefined();
    expect(presetDefaultsFor('ocr')).toBeUndefined();
    setPresetStep(1); // step 1 = ocr
    expect(presetDefaultsFor('ocr')).toEqual({
      engine: 'tesseract',
      output: 'searchable-pdf',
    });
    setPresetStep(2); // step 2 = page-numbers
    expect(presetDefaultsFor('page-numbers')).toEqual({ preset: 1 });
  });

  it('stamp-compress seeds the watermark text; unlock-merge seeds decrypt mode', () => {
    startPresetSession('stamp-compress'); // step 0 = watermark
    expect(presetDefaultsFor('watermark')).toEqual({ text: 'BẢN LƯU' });
    clearPresetSession();
    startPresetSession('unlock-merge'); // step 0 = encrypt
    expect(presetDefaultsFor('encrypt')).toEqual({ mode: 'decrypt' });
  });

  it('returns undefined for tools in NO preset and after clear', () => {
    startPresetSession('quick-merge-compress');
    expect(presetDefaultsFor('split')).toBeUndefined();
    clearPresetSession();
    expect(presetDefaultsFor('compress')).toBeUndefined();
  });
});

describe('chain flow rides the existing handoff', () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

  it('park output → advance → next step sees its defaults (append-only)', () => {
    // Simulates the banner's advance(): append (never replace), then walk.
    appendPendingFiles([new File([bytes], 'os-launch.pdf', { type: 'application/pdf' })]);
    appendPendingFiles([new File([bytes], 'merged.pdf', { type: 'application/pdf' })]);
    startPresetSession('quick-merge-compress');
    expect(presetDefaultsFor('merge')).toBeUndefined(); // merge has no defaults
    setPresetStep(1); // compress
    expect(presetDefaultsFor('compress')).toEqual({ mode: 'vector' });
    expect(pendingFileCount()).toBe(2); // parked batch survived the append
    const taken = takePendingFiles();
    expect(taken?.files.map((f) => f.name)).toEqual(['os-launch.pdf', 'merged.pdf']);
  });
});

describe('locale parity for the new preset keys', () => {
  it('vi and en carry the identical presets key set', () => {
    expect(Object.keys(enCommon.presets).sort()).toEqual(Object.keys(viCommon.presets).sort());
  });

  it('every preset slug has a name and a description in both locales', () => {
    for (const preset of PRESETS) {
      for (const suffix of ['_name', '_desc'] as const) {
        const key = `${preset.slug}${suffix}`;
        expect(typeof enCommon.presets[key as keyof typeof enCommon.presets]).toBe('string');
        expect(typeof viCommon.presets[key as keyof typeof viCommon.presets]).toBe('string');
      }
    }
  });

  it('every intake variant has a dropzone title and hint', () => {
    for (const part of ['pdf-multi', 'image', 'pdf-single'] as const) {
      expect(enCommon.presets[`drop_title_${part}` as keyof typeof enCommon.presets]).toBeTruthy();
      expect(enCommon.presets[`drop_hint_${part}` as keyof typeof enCommon.presets]).toBeTruthy();
      expect(viCommon.presets[`drop_title_${part}` as keyof typeof viCommon.presets]).toBeTruthy();
      expect(viCommon.presets[`drop_hint_${part}` as keyof typeof viCommon.presets]).toBeTruthy();
    }
  });
});

describe('getPreset', () => {
  it('finds by slug and returns undefined for unknown', () => {
    expect(getPreset('scan-number')?.steps).toHaveLength(3);
    expect(getPreset('nope')).toBeUndefined();
  });
});
