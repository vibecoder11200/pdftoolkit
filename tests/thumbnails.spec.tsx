// @vitest-environment jsdom
// Race test for plan finding #9 (red team): reordering while thumbnail
// renders are pending must not mispaint — blob URLs stay keyed to stable
// page ids, in-flight renders from an older generation are dropped, and
// the render queue re-arms instead of wedging.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useThumbnails, type ThumbJob } from '../src/hooks/use-thumbnails';

// jsdom lacks canvas.toBlob and (in this version) Blob URL registry.
const blobText = new WeakMap<Blob, string>();
let urlCounter = 0;
const urlText = new Map<string, string>();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob) => void) {
    const text = `page-${(this as HTMLElement).dataset.page ?? '?'}`;
    const blob = new Blob([text]);
    blobText.set(blob, text);
    cb(blob);
  };
  URL.createObjectURL = (blob: Blob) => {
    urlCounter += 1;
    const url = `blob:u${urlCounter}`;
    urlText.set(url, blobText.get(blob) ?? '?');
    return url;
  };
  URL.revokeObjectURL = (url: string) => void urlText.delete(url);
});

// IntersectionObserver stub whose observe() fires the callback like a real
// browser does for initially-visible elements.
type IoEntry = { target: HTMLElement; isIntersecting: boolean };
class FakeIntersectionObserver {
  observed = new Set<HTMLElement>();
  constructor(private cb: (entries: IoEntry[]) => void) {}
  observe(el: HTMLElement) {
    this.observed.add(el);
    queueMicrotask(() => this.cb([{ target: el, isIntersecting: true }]));
  }
  unobserve(el: HTMLElement) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
}
vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

// Deferred fake renderer: records the page on the canvas (the hook's toBlob
// turns that into the blob text) and resolves only when the test allows.
let pending: { page: number; resolve: () => void }[] = [];

vi.mock('../src/engine/pdfjs', () => ({
  renderPageToCanvas: vi.fn(
    (_bytes: Uint8Array, page: number, canvas: HTMLCanvasElement, _scale: number) =>
      new Promise<void>((resolve) => {
        (canvas as HTMLElement).dataset.page = String(page);
        pending.push({ page, resolve });
      }),
  ),
}));

const { renderPageToCanvas } = await import('../src/engine/pdfjs');
const renderMock = vi.mocked(renderPageToCanvas);

function job(id: string, page: number, version = 0): ThumbJob {
  // Bytes are opaque to the mocked renderer; identity is all that matters.
  return { id, bytes: new Uint8Array(8), page, version };
}

let api: ReturnType<typeof useThumbnails> | null = null;
let root: Root | null = null;

function Harness({ jobs }: { jobs: ThumbJob[] }) {
  api = useThumbnails(jobs);
  return null;
}

function mount(jobs: ThumbJob[]) {
  const container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => {
    root!.render(<Harness jobs={jobs} />);
  });
  // Register cells like ThumbnailStrip's ref callbacks do.
  act(() => {
    for (const j of jobs) {
      const el = document.createElement('div');
      container.appendChild(el);
      api!.observe(j.id, el);
    }
  });
}

async function rerender(jobs: ThumbJob[]) {
  await act(async () => {
    root!.render(<Harness jobs={jobs} />);
    await Promise.resolve();
  });
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function resolveAll() {
  for (const p of pending) p.resolve();
  pending = [];
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  api = null;
  pending = [];
  document.body.innerHTML = '';
});

describe('useThumbnails race safety (phase 2 finding #9)', () => {
  it('keeps urls keyed to page ids while a reorder lands mid-render', async () => {
    const jobs = [job('p1', 1), job('p2', 2), job('p3', 3)];
    renderMock.mockClear();
    mount(jobs);
    await flush(); // IO initial observations queue p1..p3

    const startedFirst = pending.map((p) => p.page);
    expect(startedFirst.length).toBeGreaterThanOrEqual(2); // concurrency 4, 3 pages

    // Reorder display order while renders are in flight (drag mid-render).
    await rerender([job('p3', 3), job('p1', 1), job('p2', 2)]);
    await flush(); // old generation aborted, queue re-armed, new renders started

    // Drain: completing renders may start still-queued ones (concurrency 4).
    for (let i = 0; i < 5 && pending.length > 0; i += 1) {
      resolveAll();
      await flush();
    }

    expect(pending).toHaveLength(0);
    // No mispaint: id -> rendered page content must match exactly.
    expect(urlText.get(api!.urlFor('p1') ?? '')).toBe('page-1');
    expect(urlText.get(api!.urlFor('p2') ?? '')).toBe('page-2');
    expect(urlText.get(api!.urlFor('p3') ?? '')).toBe('page-3');
    // The queue did not wedge: every page ended up rendered.
    const renderedPages = renderMock.mock.calls.map((c) => c[1]);
    for (const p of [1, 2, 3]) expect(renderedPages).toContain(p);
  });

  it('drops stale renders and re-renders after version bump (rotate/delete reload)', async () => {
    renderMock.mockClear();
    mount([job('p1', 1), job('p2', 2)]);
    await flush();
    resolveAll();
    await flush();
    const urlBefore = api!.urlFor('p1');
    expect(urlBefore).not.toBeNull();

    // p1 bumped (document reloaded with rotation), p2 removed.
    await rerender([job('p1', 1, 1)]);
    await flush();
    expect(api!.urlFor('p2')).toBeNull(); // revoked with the old document
    expect(urlText.has(urlBefore!)).toBe(false);

    resolveAll();
    await flush();
    const urlAfter = api!.urlFor('p1');
    expect(urlAfter).not.toBeNull();
    expect(urlAfter).not.toBe(urlBefore);
    expect(urlText.get(urlAfter ?? '')).toBe('page-1');
  });
});
