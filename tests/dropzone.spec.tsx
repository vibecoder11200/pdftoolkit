// @vitest-environment jsdom
// Debt item (v0.3.0 phase 1): single-file tools used to swallow files 2..N
// silently. The Dropzone itself must truncate to the first file AND say so.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18n from '../src/i18n';
import { Dropzone } from '../src/components/ui/dropzone';

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

const pdfFile = (name: string) => new File(['%PDF-1.4'], name, { type: 'application/pdf' });

function renderDropzone(props: { multiple?: boolean; onFiles: (files: File[]) => void }) {
  act(() => {
    root.render(
      <Dropzone title="Drop PDF" hint="or click" accept="application/pdf,.pdf" {...props} />,
    );
  });
}

function dropEvent(files: File[]): DragEvent {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  return event;
}

describe('Dropzone single-file truncation', () => {
  it('multiple={false} + 2 dropped files → emits only the first AND shows a status note', () => {
    const onFiles = vi.fn();
    renderDropzone({ multiple: false, onFiles });
    const surface = container.querySelector('[role="button"]')!;
    act(() => {
      surface.dispatchEvent(dropEvent([pdfFile('a.pdf'), pdfFile('b.pdf')]));
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['a.pdf']);
    const note = container.querySelector('[role="status"]');
    expect(note).not.toBeNull();
    expect(note!.textContent).not.toBe(''); // surfaced copy, not a blank marker
  });

  it('multiple={false} input picker path truncates the same way', () => {
    const onFiles = vi.fn();
    renderDropzone({ multiple: false, onFiles });
    const input = container.querySelector('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [pdfFile('a.pdf'), pdfFile('b.pdf')] });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['a.pdf']);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('multiple={false} + 1 file → no truncation note', () => {
    const onFiles = vi.fn();
    renderDropzone({ multiple: false, onFiles });
    const surface = container.querySelector('[role="button"]')!;
    act(() => {
      surface.dispatchEvent(dropEvent([pdfFile('only.pdf')]));
    });
    expect(onFiles.mock.calls[0][0]).toHaveLength(1);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('default multiple drop passes every file through, no note', () => {
    const onFiles = vi.fn();
    renderDropzone({ onFiles });
    const surface = container.querySelector('[role="button"]')!;
    act(() => {
      surface.dispatchEvent(dropEvent([pdfFile('a.pdf'), pdfFile('b.pdf')]));
    });
    expect(onFiles.mock.calls[0][0]).toHaveLength(2);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
