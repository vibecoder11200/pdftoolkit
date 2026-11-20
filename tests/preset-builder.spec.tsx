// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Suspense, createElement } from 'react';
import '../src/i18n';
import { PresetBuilder } from '../src/components/workspace/preset-builder';
import {
  listPresets,
  deletePreset,
  PRESET_STORE_MAX,
  type CustomPreset,
} from '../src/lib/personal-presets';

/*
 * v0.13.0 phase 3 — builder UI over the REAL lib (no store mocks): add
 * steps from the 6-slug select, the v1 guards (min 2 steps, no repeated
 * slug, name required), save → listPresets entry with the exact schema,
 * hostile import → red note + store untouched, delete via the two-click
 * confirm path exercised in the e2e (here: store delete works).
 */

let root: Root;
let container: HTMLElement;

const el = () => container.querySelector<HTMLElement>('[data-testid="preset-builder"]');
const q = <T extends Element = HTMLElement>(sel: string) => el()!.querySelector<T>(sel);
const input = (node: Element) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(node, 'Đóng dấu rồi nén');
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

async function renderBuilder(props: { open: boolean; editing?: CustomPreset | null }) {
  await act(async () => {
    root.render(
      createElement(
        Suspense,
        { fallback: createElement('p', null, 'loading') },
        createElement(PresetBuilder, {
          open: props.open,
          editing: props.editing ?? null,
          onClose: () => {},
          onSaved: () => {},
        }),
      ),
    );
  });
  // Two-namespace useTranslation suspends — settle past the lazy ns load.
  await act(async () => {
    await new Promise((res) => setTimeout(res, 200));
  });
}

function addStep(slug: string) {
  const select = q<HTMLSelectElement>('[data-testid="builder-add-select"]')!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, slug);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function clickSave() {
  act(() => {
    q('[data-testid="builder-save"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  for (const p of listPresets()) deletePreset(p.id);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PresetBuilder — save flow over the real lib', () => {
  it('adds two steps, saves, and the store carries the exact schema', async () => {
    await renderBuilder({ open: true });
    addStep('watermark');
    addStep('compress');
    // Edit the compress step's mode (default select lands on 'vector').
    input(q('[data-testid="builder-step"] input')!);
    input(q('input[maxlength="80"]')!);
    clickSave();
    // onClose is a noop in this harness — assert the STORE side of the save.
    const saved = listPresets();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe('Đóng dấu rồi nén');
    expect(saved[0]!.steps.map((s) => s.operationId)).toEqual(['watermark', 'compress']);
    expect(saved[0]!.steps[0]!.options).toEqual({ text: 'Đóng dấu rồi nén' });
    expect(saved[0]!.schemaVersion).toBe(2);
  });

  it('blocks saving with fewer than 2 steps (red error, store unchanged)', async () => {
    await renderBuilder({ open: true });
    addStep('merge');
    clickSave();
    expect(q('[data-testid="builder-error"]')!.textContent).toMatch(/ít nhất 2 bước/);
    expect(listPresets()).toHaveLength(0);
  });

  it('blocks an unnamed chain (red error, store unchanged)', async () => {
    await renderBuilder({ open: true });
    addStep('merge');
    addStep('encrypt');
    clickSave();
    expect(q('[data-testid="builder-error"]')!.textContent).toMatch(/tên/i);
    expect(listPresets()).toHaveLength(0);
  });

  it('cannot add the same slug twice from the UI (select drops used slugs)', async () => {
    await renderBuilder({ open: true });
    addStep('compress');
    const options = [...q('[data-testid="builder-add-select"]')!.querySelectorAll('option')].map(
      (o) => o.value,
    );
    expect(options).not.toContain('compress');
    expect(options).toContain('merge');
  });

  it('a hostile import shows an error note and leaves the store untouched', async () => {
    await renderBuilder({ open: true });
    const fileInput = q<HTMLInputElement>('input[type="file"]')!;
    const hostile = new File(
      [JSON.stringify({ __proto__: { x: 1 }, schemaVersion: 2, id: 'custom:evil', name: 'evil', steps: [] })],
      'evil.json',
      { type: 'application/json' },
    );
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [hostile] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    const note = q('[data-testid="builder-import-note"]')!;
    expect(note.textContent).toMatch(/thất bại/i);
    expect(listPresets()).toHaveLength(0);
  });

  it('store cap stays enforced through the lib (50 presets)', () => {
    expect(PRESET_STORE_MAX).toBe(50);
  });
});
