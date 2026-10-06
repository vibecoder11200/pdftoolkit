// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { initLaunchQueue, routeForLaunch, type LaunchRoute } from '../src/lib/launch-queue';

type Consumer = (params: { files?: { getFile(): Promise<File> }[] }) => void;

const withLaunchQueue = (impl: unknown) => {
  (window as unknown as { launchQueue?: unknown }).launchQueue = impl;
};

afterEach(() => {
  delete (window as unknown as { launchQueue?: unknown }).launchQueue;
});

describe('routeForLaunch', () => {
  it('routes the root to home and anything else to tool', () => {
    expect(routeForLaunch('/')).toBe<LaunchRoute>('home');
    expect(routeForLaunch('/tools/merge')).toBe<LaunchRoute>('tool');
    expect(routeForLaunch('/tools/pdf-to-img')).toBe<LaunchRoute>('tool');
  });
});

describe('initLaunchQueue', () => {
  it('delivers OS files through getFile() to the handler', async () => {
    const file = new File(['x'], 'handled.pdf', { type: 'application/pdf' });
    let consumer: Consumer | null = null;
    withLaunchQueue({ setConsumer: (cb: Consumer) => (consumer = cb) });
    const got: File[][] = [];
    initLaunchQueue((files) => got.push(files));
    expect(consumer).toBeTypeOf('function');
    consumer!({ files: [{ getFile: async () => file }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(1);
    expect(got[0][0].name).toBe('handled.pdf');
  });

  it('ignores an empty launch (no files param)', async () => {
    let consumer: Consumer | null = null;
    withLaunchQueue({ setConsumer: (cb: Consumer) => (consumer = cb) });
    const got: File[][] = [];
    initLaunchQueue((files) => got.push(files));
    consumer!({});
    consumer!({ files: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(0);
  });

  it('is a silent no-op without launchQueue (Safari/Firefox)', () => {
    expect(() => initLaunchQueue(() => undefined)).not.toThrow();
  });

  it('is a silent no-op when setConsumer is missing', () => {
    withLaunchQueue({});
    expect(() => initLaunchQueue(() => undefined)).not.toThrow();
  });

  it('skips handles whose getFile rejects and still delivers the rest', async () => {
    const good = new File(['y'], 'good.pdf', { type: 'application/pdf' });
    let consumer: Consumer | null = null;
    withLaunchQueue({ setConsumer: (cb: Consumer) => (consumer = cb) });
    const got: File[][] = [];
    initLaunchQueue((files) => got.push(files));
    consumer!({
      files: [
        { getFile: async () => Promise.reject(new Error('revoked')) },
        { getFile: async () => good },
      ],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(1);
    expect(got[0].map((f) => f.name)).toEqual(['good.pdf']);
  });
});
