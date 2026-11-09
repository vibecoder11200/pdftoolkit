// @vitest-environment jsdom
// Compare tool (v0.11.0 phase 7, plan 261109-1101): jsdom render through the
// mocked main-thread engine — probe counts gate the CTA, the result view
// renders banners/stats/overlay marks/navigator badges, SWAP BY REFERENCE
// keeps the per-slot CompWord caches (zero re-extraction on re-run), the
// engine-crash mapping surfaces with Retry, and the page cap refuses at
// probe time. Wholesale + unaligned degrade rendering pinned through the
// REAL compare path (disjoint word sets → no digest match → index pairing
// → snapshot-cap bail), not a stubbed CompareResult.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../src/i18n';
import i18n from '../src/i18n';
import type { VisualTextItem } from '../src/engine/pdfjs';
import { CompareTool } from '../src/components/workspace/compare-tool';

// jsdom lacks canvas.toBlob and the Blob URL registry (thumbnails hook).
const blobText = new WeakMap<Blob, string>();
let urlCounter = 0;
const urlText = new Map<string, string>();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom's File predates Blob.arrayBuffer — bridge it through FileReader.
  (File.prototype as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer ??= function (this: File) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as ArrayBuffer);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(this);
    });
  };
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
  class FakeRO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', FakeRO);
});

// Engine table keyed by a content signature — slot bytes are COPIES of the
// File buffer, so identity fails; content (first 24 bytes) is stable.
type DocSpec = { count: number; pages: Record<number, VisualTextItem[]> };
const engineTable = new Map<string, DocSpec>();
// pdf-lib emits IDENTICAL headers — a head-only signature collides.
const sig = (b: Uint8Array) => `${b.length}:${Array.from(b.slice(0, 8)).join(',')}:${Array.from(b.slice(-8)).join(',')}`;
let itemCalls = 0;
let crashFirst = false;

vi.mock('../src/engine/pdfjs', () => ({
  getPageCount: vi.fn(async (b: Uint8Array) => {
    const spec = engineTable.get(sig(b));
    if (!spec) throw new Error('unregistered doc');
    return spec.count;
  }),
  getPageVisualSize: vi.fn(async () => ({ width: 595, height: 842 })),
  getVisualTextItems: vi.fn(async (b: Uint8Array, page: number) => {
    const spec = engineTable.get(sig(b));
    if (!spec) throw new Error('unregistered doc');
    if (crashFirst) {
      const e = new Error('worker died');
      e.name = 'EngineCrashedError';
      throw e;
    }
    itemCalls += 1;
    return spec.pages[page] ?? [];
  }),
  renderPageToCanvas: vi.fn(async (_b: Uint8Array, page: number, canvas: HTMLCanvasElement) => {
    (canvas as HTMLElement).dataset.page = String(page);
  }),
}));

function line(str: string, x: number, baseline: number, size = 11): VisualTextItem {
  return { str, x0: x, x1: x + str.length * size * 0.5, baseline, size, fontName: 'Helvetica', rotated: false };
}
function pageLines(lines: string[], y0 = 760, pitch = 20): VisualTextItem[] {
  return lines.map((s, i) => line(s, 64, y0 - i * pitch));
}
// One long item per page: whitespace split yields n words; all disjoint.
function disjointWords(prefix: string, n: number): VisualTextItem[] {
  return [line(Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' '), 64, 760, 11)];
}

const A_BYTES = Uint8Array.from(readFileSync(join('tests/fixtures/fixture-compare-a.pdf')));
const B_BYTES = Uint8Array.from(readFileSync(join('tests/fixtures/fixture-compare-b.pdf')));
const fileOf = (b: Uint8Array, name: string) => new File([b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer], name, { type: 'application/pdf' });

function registerStandardDocs(): void {
  itemCalls = 0;
  crashFirst = false;
  engineTable.set(sig(A_BYTES), {
    count: 2,
    pages: {
      1: pageLines(['Report — Sample Division', 'Revenue grew steadily across the region', 'Costs stayed flat for the whole year', 'Headcount reached 120 by December']),
      2: pageLines(['Appendix: regional breakdown', 'North contributed 40 percent', 'South contributed 35 percent', 'West contributed 25 percent']),
    },
  });
  engineTable.set(sig(B_BYTES), {
    count: 3,
    pages: {
      1: pageLines(['Report — Sample Division', 'Revenue grew sharply across the region', 'Costs stayed flat for the whole year', 'Headcount reached 120 by December']),
      2: pageLines(['Appendix: regional breakdown', 'North contributed 40 percent', 'South contributed 35 percent', 'West contributed 25 percent']),
      3: pageLines(['Addendum', 'New: expansion plan draft', 'Two depots open in March', 'Fleet telemetry rollout completes']),
    },
  });
}

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
  // useTranslation(['common', 'tools']) SUSPENDS on the lazy tools ns —
  // no Suspense wrapper here, so preload it (v0.8.1 ns discipline).
  await i18n.loadNamespaces(['tools']);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  engineTable.clear();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 12));
  });
}
async function waitFor(fn: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (fn()) return;
    await flush();
  }
  throw new Error('waitFor: condition never became true');
}

async function dropAandB(): Promise<void> {
  act(() => {
    root.render(<CompareTool />);
  });
  const surfaces = () => container.querySelectorAll<HTMLElement>('[role="button"]');
  expect(surfaces().length).toBe(2);
  const drop = (el: HTMLElement, f: File) => {
    const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: { files: [f] } });
    act(() => el.dispatchEvent(event));
  };
  drop(surfaces()[0]!, fileOf(A_BYTES, 'a.pdf'));
  await flush();
  expect(surfaces().length).toBe(1);
  drop(surfaces()[0]!, fileOf(B_BYTES, 'b.pdf'));
  // Chips replace both dropzones; the probe's async page-count fetch may
  // still be pending — the CALLER waits for its own probe condition.
  await waitFor(() => container.querySelectorAll('[role="button"]').length === 0);
}

const btn = (label: string): HTMLButtonElement => {
  const b = [...container.querySelectorAll('button')].find((x) => x.textContent === label);
  if (!b) throw new Error(`button not found: ${label}`);
  return b;
};

describe('Compare tool (phase 7)', () => {
  it('probe counts gate the CTA; the result view renders stats, banners, marks and badges', async () => {
    registerStandardDocs();
    await dropAandB();
    await waitFor(() => container.textContent?.includes('2/3') ?? false);
    const cta = btn('So sánh ngay');
    expect(cta.hasAttribute('disabled')).toBe(false);
    act(() => cta.click());
    await waitFor(() => container.querySelector('[data-testid="compare-result"]') !== null);
    // Pair auto-jumps to the FIRST changed pair (page 1).
    expect(container.textContent).toContain('Cặp trang 1');
    expect(container.textContent).toContain('Trang chỉ có ở bản sửa: 3');
    expect(container.textContent).not.toContain('Trang chỉ có ở bản gốc');
    expect(container.textContent).toContain('1 trang có thay đổi');
    // Overlay (side B default): 'sharply' inserted — exactly one mark.
    expect(container.querySelectorAll('[data-testid="compare-ins-mark"]').length).toBe(1);
    // Switch to side A: 'steadily' removed — the strikethrough mark.
    act(() => btn('Bản gốc').click());
    await flush();
    expect(container.querySelectorAll('[data-testid="compare-del-mark"]').length).toBe(1);
    // Navigator badges: B1 changed, B3 added, B2 clean.
    const badges = [...container.querySelectorAll('[data-testid="thumb-badge"]')].map((b) => b.textContent);
    expect(badges.filter((s) => s === 'Đã đổi').length).toBe(1);
    expect(badges.filter((s) => s === 'Trang mới').length).toBe(1);
    // A/B toggle present; switching to A keeps the viewer mounted.
    expect(container.querySelector('[role="group"]')).not.toBeNull();
  });

  it('swap-by-reference: a swap then re-run costs ZERO re-extraction (caches travel with slots)', async () => {
    registerStandardDocs();
    await dropAandB();
    act(() => btn('So sánh ngay').click());
    await waitFor(() => container.querySelector('[data-testid="compare-result"]') !== null);
    const afterFirstRun = itemCalls;
    // A(2) + B(3) pages extracted exactly once each.
    expect(afterFirstRun).toBe(5);
    act(() => btn('Đổi chỗ A ↔ B').click());
    await waitFor(() => container.textContent?.includes('3/2') ?? false);
    await waitFor(() => !btn('So sánh ngay').hasAttribute('disabled'));
    act(() => btn('So sánh ngay').click());
    await waitFor(() => container.querySelector('[data-testid="compare-result"]') !== null);
    // No additional extraction: both WordLru caches returned every page.
    expect(itemCalls).toBe(afterFirstRun);
  });

  it('engine crash during extraction maps to the crash copy with Retry', async () => {
    registerStandardDocs();
    crashFirst = true;
    await dropAandB();
    act(() => btn('So sánh ngay').click());
    await waitFor(() => container.textContent?.includes('Bộ xử lý PDF gặp sự cố') ?? false);
    // The result view never mounts on a crash.
    expect(container.querySelector('[data-testid="compare-result"]')).toBeNull();
  });

  it('page-cap refusal surfaces at probe time and keeps the CTA disabled', async () => {
    itemCalls = 0;
    crashFirst = false;
    engineTable.set(sig(A_BYTES), { count: 150, pages: {} });
    engineTable.set(sig(B_BYTES), { count: 3, pages: {} });
    await dropAandB();
    // The banner reports the CAP (100), not the offending doc's size.
    await waitFor(() => container.textContent?.includes('giới hạn 100 trang') ?? false);
    expect(btn('So sánh ngay').hasAttribute('disabled')).toBe(true);
  });

  it('unaligned docs render the notice; every paired page degrades wholesale', async () => {
    itemCalls = 0;
    crashFirst = false;
    // 2×2 docs, all page word-sets disjoint → no digest match anywhere
    // (unaligned) and D ≈ 2×words > snapshot cap ⇒ wholesale per pair.
    const words = 1400;
    engineTable.set(sig(A_BYTES), {
      count: 2,
      pages: { 1: disjointWords('x', words), 2: disjointWords('y', words) },
    });
    engineTable.set(sig(B_BYTES), {
      count: 2,
      pages: { 1: disjointWords('z', words), 2: disjointWords('w', words) },
    });
    await dropAandB();
    await waitFor(() => !btn('So sánh ngay').hasAttribute('disabled'));
    act(() => btn('So sánh ngay').click());
    await waitFor(() => container.querySelector('[data-testid="compare-wholesale"]') !== null);
    expect(container.textContent).toContain('khác cấu trúc quá nhiều');
    expect(container.textContent).toContain('hiển thị nguyên văn');
    // Wholesale pairs draw no overlay marks.
    expect(container.querySelector('[data-testid="compare-ins-mark"]')).toBeNull();
    expect(container.querySelector('[data-testid="compare-del-mark"]')).toBeNull();
  });
});
