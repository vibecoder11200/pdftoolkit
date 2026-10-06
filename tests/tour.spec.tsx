// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18n from '../src/i18n';
import { Tour } from '../src/components/layout/tour';

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(window.navigator, 'webdriver', { value: false, configurable: true });
  // i18next attaches resources on the next tick; wait so t() never shows raw keys.
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  sessionStorage.clear();
});

const renderTour = () =>
  act(async () => {
    root.render(<Tour />);
  });

const dialog = () => container.querySelector('[role="dialog"]');

describe('Tour gating', () => {
  it('mounts for a first visit (no flags set)', async () => {
    await renderTour();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute('aria-label')).toContain('Chào mừng');
  });

  it('does not mount when the done flag is set', async () => {
    localStorage.setItem('pdftoolkit-tour-done', '1');
    await renderTour();
    expect(dialog()).toBeNull();
  });

  it('does not mount when a tool was visited this session', async () => {
    sessionStorage.setItem('pdftoolkit-tool-visited', '1');
    await renderTour();
    expect(dialog()).toBeNull();
  });

  it('does not mount under automation without an explicit replay request', async () => {
    Object.defineProperty(window.navigator, 'webdriver', { value: true, configurable: true });
    await renderTour();
    expect(dialog()).toBeNull();
    Object.defineProperty(window.navigator, 'webdriver', { value: false, configurable: true });
  });

  it('replay flag overrides everything and clears itself', async () => {
    localStorage.setItem('pdftoolkit-tour-done', '1');
    localStorage.setItem('pdftoolkit-tour-replay', '1');
    sessionStorage.setItem('pdftoolkit-tool-visited', '1');
    await renderTour();
    expect(dialog()).not.toBeNull();
    expect(localStorage.getItem('pdftoolkit-tour-replay')).toBeNull();
  });
});

describe('Tour flow', () => {
  it('Next advances steps, finish persists done, re-render stays hidden', async () => {
    await renderTour();
    const next = () => {
      const btn = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Tiếp');
      return btn!;
    };
    await act(async () => next().click());
    expect(dialog()!.getAttribute('aria-label')).toContain('Thả file');
    await act(async () => next().click());
    await act(async () => next().click());
    const finish = [...dialog()!.querySelectorAll('button')].find(
      (b) => b.textContent === 'Bắt đầu dùng',
    )!;
    await act(async () => finish.click());
    expect(dialog()).toBeNull();
    expect(localStorage.getItem('pdftoolkit-tour-done')).toBe('1');
    // Re-mount: done flag keeps the tour away.
    root = createRoot(container);
    await renderTour();
    expect(dialog()).toBeNull();
  });

  it('Skip also persists the done flag', async () => {
    await renderTour();
    const skip = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Bỏ qua')!;
    await act(async () => skip.click());
    expect(dialog()).toBeNull();
    expect(localStorage.getItem('pdftoolkit-tour-done')).toBe('1');
  });

  it('Escape dismisses and persists', async () => {
    await renderTour();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(dialog()).toBeNull();
    expect(localStorage.getItem('pdftoolkit-tour-done')).toBe('1');
  });

  it('spotlight ring re-measures around the dropzone step', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-tour', 'hero-dropzone');
    document.body.appendChild(target);
    try {
      await renderTour();
      const next = () =>
        [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Tiếp')!;
      await act(async () => next().click());
      // The ring div carries the giant box-shadow overlay.
      const ring = [...container.querySelectorAll<HTMLElement>('[aria-hidden]')].find((el) =>
        el.style.boxShadow.includes('200vmax'),
      );
      expect(ring).toBeDefined();
    } finally {
      target.remove();
    }
  });
});
