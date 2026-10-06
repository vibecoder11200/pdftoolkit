// @vitest-environment jsdom
// ThumbnailStrip keyboard reorder: Alt+Arrow moves via onMove (with the
// display-position contract), announces the move to screen readers, and —
// review P0 — never lets the combo fall through to browser Back/Forward at
// the first/last boundary.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../src/i18n';
import i18n from '../src/i18n';
import { ThumbnailStrip } from '../src/components/workspace/thumbnail-strip';

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const PAGES = [1, 2, 3].map((n) => ({
  key: `p${n}`,
  pageNumber: n,
  url: null,
  selected: true,
}));

const renderStrip = (onMove: (from: number, to: number) => void) =>
  act(async () => {
    root.render(
      <ThumbnailStrip
        pages={PAGES}
        fullscreenTitle={(n) => `Trang ${n}`}
        closeLabel="Đóng"
        onToggle={() => {}}
        onMove={onMove}
        keyboardMoveHint="Alt + ←/→"
      />,
    );
  });

const cells = () => [...container.querySelectorAll('[role="checkbox"]')];

const pressArrow = async (cell: HTMLElement, key: 'ArrowLeft' | 'ArrowRight', alt = true) => {
  await act(async () => {
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key, altKey: alt, bubbles: true, cancelable: true }),
    );
  });
};

describe('ThumbnailStrip keyboard move', () => {
  it('Alt+ArrowRight moves the focused cell and announces the new position', async () => {
    const onMove = vi.fn();
    await renderStrip(onMove);
    await pressArrow(cells()[0] as HTMLElement, 'ArrowRight');
    expect(onMove).toHaveBeenCalledWith(1, 2);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('vị trí 2');
  });

  it('boundary hit does NOT move and DOES cancel the default (no browser Back)', async () => {
    const onMove = vi.fn();
    await renderStrip(onMove);
    const cell = cells()[0] as HTMLElement;
    await pressArrow(cell, 'ArrowLeft');
    expect(onMove).not.toHaveBeenCalled();
    // jsdom does not perform navigation; assert preventDefault took effect by
    // checking defaultPrevented on a re-dispatched event we can inspect.
    const evt = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => cell.dispatchEvent(evt));
    expect(evt.defaultPrevented).toBe(true);
  });

  it('plain arrows (no Alt) never move — combo must match exactly', async () => {
    const onMove = vi.fn();
    await renderStrip(onMove);
    await pressArrow(cells()[1] as HTMLElement, 'ArrowRight', false);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('cells carry i18n page labels (was hardcoded English)', async () => {
    await renderStrip(vi.fn());
    expect((cells()[0] as HTMLElement).getAttribute('aria-label')).toBe('Trang 1');
  });
});
