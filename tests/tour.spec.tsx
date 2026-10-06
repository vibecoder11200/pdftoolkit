// @vitest-environment jsdom
// React 19 warns on act() outside a declared act environment — tests here
// drive updates through act() deliberately.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18n from '../src/i18n';
import { clearPendingFiles, setPendingFiles } from '../src/lib/handoff';
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
// Select by testid + the numeric step counter, never by copy — the copy is
// VI and belongs to the locale files, not to behavior assertions.
const stepCounter = () => dialog()!.querySelector('.tabular-nums')!.textContent;

describe('Tour gating', () => {
  it('mounts for a first visit (no flags set)', async () => {
    await renderTour();
    expect(dialog()).not.toBeNull();
    expect(stepCounter()).toBe('1/4');
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

  it('replay event opens the tour on an already-mounted, already-done home', async () => {
    // Footer "Quick tour" clicked while home is already up: the mount gate
    // ran long ago, so the window event is what reopens the tour.
    localStorage.setItem('pdftoolkit-tour-done', '1');
    await renderTour();
    expect(dialog()).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('pdftoolkit:tour-replay'));
    });
    expect(dialog()).not.toBeNull();
  });

  it('closes (and persists done) when files arrive mid-tour', async () => {
    await renderTour();
    expect(dialog()).not.toBeNull();
    await act(async () => {
      setPendingFiles([new File(['x'], 'mid-tour.pdf', { type: 'application/pdf' })]);
    });
    expect(dialog()).toBeNull();
    expect(localStorage.getItem('pdftoolkit-tour-done')).toBe('1');
    clearPendingFiles();
  });
});

describe('Tour flow', () => {
  it('Next advances steps, finish persists done, re-render stays hidden', async () => {
    await renderTour();
    const primary = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="tour-primary"]')!;
    await act(async () => primary().click());
    expect(stepCounter()).toBe('2/4');
    await act(async () => primary().click());
    await act(async () => primary().click());
    expect(stepCounter()).toBe('4/4');
    await act(async () => primary().click());
    expect(dialog()).toBeNull();
    expect(localStorage.getItem('pdftoolkit-tour-done')).toBe('1');
    // Re-mount: done flag keeps the tour away.
    root = createRoot(container);
    await renderTour();
    expect(dialog()).toBeNull();
  });

  it('Skip also persists the done flag', async () => {
    await renderTour();
    const skip = container.querySelector<HTMLButtonElement>('[data-testid="tour-skip"]')!;
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
        container.querySelector<HTMLButtonElement>('[data-testid="tour-primary"]')!;
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
