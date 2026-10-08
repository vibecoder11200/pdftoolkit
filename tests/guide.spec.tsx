// @vitest-environment jsdom
// React 19 warns on act() outside a declared act environment — tests here
// drive updates through act() deliberately.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../src/i18n';
import {
  GuideWelcome,
  QuickGuide,
  markToolVisited,
  openQuickGuide,
} from '../src/components/layout/quick-guide';

/*
 * v0.5.2 quick-guide contract (replaces the spotlight tour): the first-visit
 * welcome is a NON-BLOCKING strip gated by localStorage('pdftoolkit-guide-seen')
 * + sessionStorage tool visits, and the guide dialog NEVER auto-activates —
 * it opens only via openQuickGuide(). The old tour re-nagged every launch
 * when its done flag was lost, and its full-screen spotlight covered the page.
 */

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  sessionStorage.clear();
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

const render = (ui: ReactNode) =>
  act(async () => {
    root.render(<MemoryRouter>{ui}</MemoryRouter>);
  });

const welcome = () => container.querySelector('[data-testid="guide-welcome"]');
const dialog = () => container.querySelector('[role="dialog"]');

describe('GuideWelcome gating', () => {
  it('renders on a first visit', async () => {
    await render(<GuideWelcome />);
    expect(welcome()).not.toBeNull();
  });

  it('stays hidden once the seen flag is set', async () => {
    localStorage.setItem('pdftoolkit-guide-seen', '1');
    await render(<GuideWelcome />);
    expect(welcome()).toBeNull();
  });

  it('stays hidden after a tool visit this session', async () => {
    markToolVisited();
    await render(<GuideWelcome />);
    expect(welcome()).toBeNull();
  });

  it('dismiss persists the seen flag and a re-render stays hidden', async () => {
    await render(<GuideWelcome />);
    const dismiss = container.querySelector<HTMLButtonElement>('[data-testid="guide-dismiss"]')!;
    await act(async () => dismiss.click());
    expect(welcome()).toBeNull();
    expect(localStorage.getItem('pdftoolkit-guide-seen')).toBe('1');
    root = createRoot(container);
    await render(<GuideWelcome />);
    expect(welcome()).toBeNull();
  });

  it('the open button marks seen AND opens the dialog through the event', async () => {
    await render(
      <>
        <GuideWelcome />
        <QuickGuide />
      </>,
    );
    const open = container.querySelector<HTMLButtonElement>('[data-testid="guide-open"]')!;
    await act(async () => open.click());
    expect(welcome()).toBeNull();
    expect(localStorage.getItem('pdftoolkit-guide-seen')).toBe('1');
    expect(dialog()).not.toBeNull();
  });
});

describe('QuickGuide dialog', () => {
  it('NEVER auto-activates on mount (the old tour regression)', async () => {
    await render(<QuickGuide />);
    expect(dialog()).toBeNull();
  });

  it('opens via openQuickGuide() with current-content links', async () => {
    await render(<QuickGuide />);
    await act(async () => openQuickGuide());
    expect(dialog()).not.toBeNull();
    const ai = container.querySelector<HTMLAnchorElement>('[data-testid="guide-link-ai"]')!;
    expect(ai.getAttribute('href')).toBe('/tools/ocr');
    const settings = container.querySelector<HTMLAnchorElement>('[data-testid="guide-link-settings"]')!;
    expect(settings.getAttribute('href')).toBe('/settings');
    const tools = container.querySelector<HTMLAnchorElement>('[data-testid="guide-link-tools"]')!;
    expect(tools.getAttribute('href')).toBe('/');
  });

  it('a guide link closes the dialog', async () => {
    await render(<QuickGuide />);
    await act(async () => openQuickGuide());
    const ai = container.querySelector<HTMLAnchorElement>('[data-testid="guide-link-ai"]')!;
    await act(async () => ai.click());
    expect(dialog()).toBeNull();
  });
});
