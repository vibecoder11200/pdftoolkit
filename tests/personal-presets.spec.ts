// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clonePreset,
  CUSTOM_ID_PREFIX,
  CUSTOM_SCHEMA_VERSION,
  deletePreset,
  exportPresets,
  importPresets,
  listPresets,
  PresetValidationError,
  resolvePreset,
  savePreset,
  validateCustomPreset,
} from '../src/lib/personal-presets';

/*
 * Phase-7 personal presets suite (RT3): per-step identity, secret-free
 * storage, hostile import rejection, migration, corrupt recovery.
 */

const preset = (name: string, steps: Record<string, unknown>[] = []) =>
  ({
    schemaVersion: CUSTOM_SCHEMA_VERSION,
    id: `${CUSTOM_ID_PREFIX}test-${name}`,
    name,
    createdAt: 1,
    updatedAt: 1,
    steps,
  }) as unknown as Parameters<typeof savePreset>[0];

beforeEach(() => {
  globalThis.localStorage?.clear();
});
afterEach(() => {
  globalThis.localStorage?.clear();
});

describe('schema validation (RT3)', () => {
  it('two steps of the SAME operation carry independent options', () => {
    const p = preset('double-wm', [
      { stepId: 'a', operationId: 'watermark', operationVersion: 1, options: { text: 'ONE' } },
      { stepId: 'b', operationId: 'watermark', operationVersion: 1, options: { text: 'TWO' } },
    ]);
    expect(() => validateCustomPreset(p)).not.toThrow();
  });

  it('duplicate stepId refused; resume-by-stepId survives reorder', () => {
    const p = preset('dup', [
      { stepId: 'a', operationId: 'watermark', operationVersion: 1, options: {} },
      { stepId: 'a', operationId: 'compress', operationVersion: 1, options: {} },
    ]);
    expect(() => validateCustomPreset(p)).toThrow(PresetValidationError);
    // reorder keeps stepIds
    const q = preset('order', [
      { stepId: 's1', operationId: 'watermark', operationVersion: 1, options: {} },
      { stepId: 's2', operationId: 'compress', operationVersion: 1, options: {} },
    ]);
    const saved = savePreset(q);
    const reordered = { ...saved, steps: [saved.steps[1]!, saved.steps[0]!] };
    savePreset(reordered);
    expect(listPresets()[0]!.steps.map((s) => s.stepId)).toEqual(['s2', 's1']);
  });

  it('secret-carrier option keys are refused (never persisted)', () => {
    const p = preset('secret', [
      { stepId: 'a', operationId: 'encrypt', operationVersion: 1, options: { password: 'hunter2' } },
    ]);
    expect(() => savePreset(p)).toThrow(PresetValidationError);
    expect(listPresets()).toHaveLength(0);
  });

  it('built-in identity untouched: custom ids always namespaced', () => {
    const resolved = resolvePreset('quick-merge-compress');
    expect(resolved?.kind).toBe('builtin');
    const custom = savePreset(preset('mine'));
    expect(custom.id.startsWith(CUSTOM_ID_PREFIX)).toBe(true);
    expect(resolvePreset(custom.id)?.kind).toBe('custom');
  });
});

describe('hostile import', () => {
  it('prototype-polluting keys rejected', () => {
    const hostile = JSON.stringify([
      {
        schemaVersion: 2,
        id: `${CUSTOM_ID_PREFIX}x`,
        name: 'x',
        createdAt: 1,
        updatedAt: 1,
        steps: [
          // raw JSON text carries the literal "__proto__" key (a JS object
          // literal would prototype-assign instead of creating an own key)
          { stepId: 'a', operationId: 'merge', operationVersion: 1, options: JSON.parse('{"__proto__": {"evil": 1}}') as Record<string, unknown> },
        ],
      },
    ]);
    expect(() => importPresets(hostile)).toThrow(PresetValidationError);
  });

  it('oversized import refused', () => {
    const big = ' '.repeat(200_000);
    expect(() => importPresets(big)).toThrow(PresetValidationError);
  });

  it('unknown version + junk shapes rejected (never executed)', () => {
    expect(() => importPresets('[{"schemaVersion":99}]')).toThrow(PresetValidationError);
    expect(() => importPresets('{"evil":"http://cdn/x.js"}')).toThrow(PresetValidationError);
    expect(() => importPresets('not json')).toThrow();
  });

  it('v1 migration synthesizes stable stepIds', () => {
    const v1 = JSON.stringify([
      { schemaVersion: 1, id: 'custom:old', name: 'Old', createdAt: 1, steps: [{ tool: 'watermark', options: { text: 'X' } }] },
    ]);
    const [migrated] = importPresets(v1);
    expect(migrated!.schemaVersion).toBe(2);
    expect(migrated!.steps[0]!.stepId).toBe('s1');
    expect(migrated!.steps[0]!.operationId).toBe('watermark');
    expect(listPresets()).toHaveLength(1);
  });
});

describe('store robustness', () => {
  it('corrupt storage quarantines + recovers to empty', () => {
    globalThis.localStorage?.setItem('pdftoolkit-presets-v2', '{not json');
    expect(listPresets()).toEqual([]);
    expect(globalThis.localStorage?.getItem('pdftoolkit-presets-quarantine')).toBe('{not json');
    expect(globalThis.localStorage?.getItem('pdftoolkit-presets-v2')).toBe('[]');
  });

  it('clone deep-copies options; delete removes', () => {
    const src = savePreset(
      preset('src', [{ stepId: 'a', operationId: 'watermark', operationVersion: 1, options: { text: 'A' } }]),
    );
    const copy = clonePreset(src, 'Copy');
    expect(copy.id).not.toBe(src.id);
    expect(copy.steps[0]!.options).toEqual({ text: 'A' });
    expect(copy.steps[0]!.options).not.toBe(src.steps[0]!.options);
    deletePreset(copy.id);
    expect(listPresets()).toHaveLength(1);
    expect(exportPresets()).toContain('src');
  });
});
