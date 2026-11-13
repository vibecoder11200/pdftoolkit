// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { installFileDropGuard } from '../src/lib/file-drop-guard';

function drag(type: string, types: string[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types } });
  return event;
}

describe('root file-only drop guard', () => {
  it('blocks defaults before a child stops propagation, without taking the drop', () => {
    const remove = installFileDropGuard(window);
    const child = document.createElement('div');
    document.body.append(child);
    let calls = 0;
    child.addEventListener('drop', (e) => { calls++; e.stopPropagation(); });
    const event = drag('drop', ['Files']);
    child.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(calls).toBe(1);
    remove();
    child.remove();
  });

  it('leaves valid bubble intake reachable exactly once', () => {
    const remove = installFileDropGuard(window);
    let calls = 0;
    const intake = () => { calls++; };
    document.addEventListener('drop', intake);
    document.dispatchEvent(drag('drop', ['Files']));
    expect(calls).toBe(1);
    document.removeEventListener('drop', intake);
    remove();
  });

  it('only cancels file dragover/drop and removes both capture listeners', () => {
    const remove = installFileDropGuard(window);
    for (const type of ['dragover', 'drop']) {
      const file = drag(type, ['Files']);
      const text = drag(type, ['text/plain']);
      const thumbnail = drag(type, ['application/x-pdftoolkit-page']);
      window.dispatchEvent(file);
      window.dispatchEvent(text);
      window.dispatchEvent(thumbnail);
      expect(file.defaultPrevented).toBe(true);
      expect(text.defaultPrevented).toBe(false);
      expect(thumbnail.defaultPrevented).toBe(false);
    }
    remove();
    for (const type of ['dragover', 'drop']) {
      const event = drag(type, ['Files']);
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });
});
