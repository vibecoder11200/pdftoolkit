// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { Dialog } from '../src/components/ui/dialog';

// Minimal harness: a trigger button outside the dialog, a Dialog with two
// focusable children. The dialog's first focusable is its ✕ close button.
// jsdom provides focus + Tab semantics; the dialog's listeners live on
// document, so dispatched keydown events must bubble.
describe('Dialog focus management', () => {
  let root: Root;
  let container: HTMLElement;
  let trigger: HTMLButtonElement;

  const dialogEl = () => container.querySelector<HTMLElement>('[role="dialog"]');
  const closeButton = () => dialogEl()?.querySelector<HTMLButtonElement>('button');

  const renderDialog = (open: boolean, onClose: () => void) => {
    act(() => {
      root.render(
        createElement(
          'div',
          null,
          createElement(Dialog, {
            open,
            onClose,
            title: 'Test dialog',
            children: [
              createElement('button', { id: 'first' }, 'First'),
              createElement('button', { id: 'last' }, 'Last'),
            ],
          }),
        ),
      );
    });
  };

  const tab = (shift = false) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    return event;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    trigger = document.createElement('button');
    trigger.id = 'outside-trigger';
    document.body.appendChild(trigger);
    trigger.focus();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    trigger.remove();
  });

  it('moves focus into the dialog (first focusable = close button) on open', () => {
    renderDialog(true, () => {});
    expect(document.activeElement).toBe(closeButton());
  });

  it('wraps Tab from the last element to the first (and Shift+Tab back)', () => {
    renderDialog(true, () => {});
    document.getElementById('last')?.focus();
    const forward = tab();
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeButton());
    const back = tab(true);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('last');
  });

  it('restores focus to the trigger when closed', () => {
    renderDialog(true, () => {});
    expect(document.activeElement).toBe(closeButton());
    renderDialog(false, () => {});
    expect(document.activeElement?.id).toBe('outside-trigger');
  });
});
