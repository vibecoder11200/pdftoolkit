// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canPickFile, saveFilePicker } from '../src/lib/fs-save';

type WritableSpy = {
  write: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

let writable: WritableSpy;

function installPicker(impl?: (...args: unknown[]) => Promise<unknown>) {
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value:
      impl ??
      vi.fn(async () => ({ createWritable: async () => writable })),
  });
}

beforeEach(() => {
  writable = {
    write: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  // @ts-expect-error test-only removal of the injected mock
  delete window.showSaveFilePicker;
});

describe('fs-save', () => {
  it('feature-detect hides the action when showSaveFilePicker is absent', async () => {
    expect(canPickFile()).toBe(false);
    // Defensive: calling the helper without the API is a programming error.
    await expect(saveFilePicker(new Blob(['x']), { fileName: 'a.pdf' })).rejects.toThrow(
      /not available/,
    );
  });

  it('saves OK: picker opens with suggested name, blob written, stream closed', async () => {
    installPicker();
    const blob = new Blob(['pdf-bytes'], { type: 'application/pdf' });
    await expect(saveFilePicker(blob, { fileName: 'out.pdf' })).resolves.toBe(true);
    expect(writable.write).toHaveBeenCalledWith(blob);
    expect(writable.close).toHaveBeenCalledTimes(1);
  });

  it('cancel (AbortError by name) resolves false without surfacing an error', async () => {
    installPicker(async () => {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      throw err;
    });
    await expect(saveFilePicker(new Blob(['x']), { fileName: 'a.pdf' })).resolves.toBe(false);
    expect(writable.write).not.toHaveBeenCalled();
  });

  it('a write failure closes the stream AND propagates (no half-written file presented as saved)', async () => {
    installPicker();
    writable.write.mockRejectedValue(new Error('disk full'));
    await expect(saveFilePicker(new Blob(['x']), { fileName: 'a.pdf' })).rejects.toThrow('disk full');
    expect(writable.close).toHaveBeenCalledTimes(1);
  });

  it('a flush (close) failure after a good write propagates — file would be truncated', async () => {
    installPicker();
    writable.close.mockRejectedValue(new Error('flush failed'));
    await expect(saveFilePicker(new Blob(['x']), { fileName: 'a.pdf' })).rejects.toThrow('flush failed');
  });

  it('non-abort picker failures (e.g. SecurityError) rethrow — real errors are surfaced', async () => {
    installPicker(async () => {
      const err = new Error('security');
      err.name = 'SecurityError';
      throw err;
    });
    await expect(saveFilePicker(new Blob(['x']), { fileName: 'a.pdf' })).rejects.toThrow('security');
  });
});
