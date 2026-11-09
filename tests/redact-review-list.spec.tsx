// @vitest-environment jsdom
// Redact review list (v0.10.2 phase 3, plan 261109-1101): grouped-by-page
// render from proposals, per-row keep/discard toggles, page accept/discard,
// click-to-jump — and the promote filter pins (per-row discard removes from
// the accept set; kept-flagged pages never promote; apply-path parity: the
// filter is the ONLY new logic — runRedactionPipeline call count untouched,
// pinned by the redact-tool apply-path spec).
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../src/i18n';
import i18n from '../src/i18n';
import { RedactReviewList, promotableMarks } from '../src/components/workspace/redact-review-list';
import type { SearchProposal } from '../src/components/workspace/editor-tool';
import type { RedactMark } from '../src/lib/redact-pipeline';

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

const mark = (id: string, page: number): RedactMark => ({ id, page, nx: 0.1, nyTop: 0.1, nw: 0.3, nh: 0.03 });
const proposal = (id: string, page: number, excerpt: string): SearchProposal => ({ mark: mark(id, page), excerpt });

const PROPOSALS: SearchProposal[] = [
  proposal('a1', 1, 'so tai khoan: 0123456789'),
  proposal('a2', 1, 'Second match on page one'),
  proposal('b1', 3, 'so tai khoan: 9876543210'),
];

function renderList(over: Partial<Parameters<typeof RedactReviewList>[0]> = {}) {
  act(() => {
    root.render(
      <RedactReviewList
        proposals={PROPOSALS}
        discardedIds={new Set<string>()}
        currentPage={1}
        onToggle={vi.fn()}
        onAcceptPage={vi.fn()}
        onDiscardPage={vi.fn()}
        onJump={vi.fn()}
        {...over}
      />,
    );
  });
}

describe('RedactReviewList (grouped review list)', () => {
  it('renders rows grouped by ascending page with excerpts', () => {
    renderList();
    const rows = container.querySelectorAll('[data-testid="redact-list-row"]');
    expect(rows).toHaveLength(3);
    // Page groups ascending: page 1 rows before page 3.
    const text = container.textContent ?? '';
    expect(text.indexOf('Trang 1 ·')).toBeGreaterThan(-1);
    expect(text.indexOf('Trang 3 ·')).toBeGreaterThan(text.indexOf('Trang 1 ·'));
    // Excerpt shown as plain text (no dangerouslySetInnerHTML).
    expect(text).toContain('so tai khoan: 0123456789');
    // Excerpts ellipsize at 60 chars.
    renderList({ proposals: [proposal('l1', 1, 'x'.repeat(80))] });
    expect(container.textContent).not.toContain('x'.repeat(80));
  });

  it('per-row toggle flips the row and never mutates proposals in place', () => {
    const onToggle = vi.fn();
    renderList({ discardedIds: new Set(['a1']), onToggle });
    const rows = container.querySelectorAll('[data-testid="redact-list-row"]');
    expect((rows[0] as HTMLElement).className).toContain('line-through');
    expect((rows[1] as HTMLElement).className).not.toContain('line-through');
    act(() => {
      (rows[1] as HTMLButtonElement).click();
    });
    expect(onToggle).toHaveBeenCalledWith('a2');
  });

  it('page accept/discard buttons target their page group', () => {
    const onAcceptPage = vi.fn();
    const onDiscardPage = vi.fn();
    renderList({ onAcceptPage, onDiscardPage });
    const buttons = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Nhận cả trang');
    act(() => {
      buttons[0]!.click();
    });
    expect(onAcceptPage).toHaveBeenCalledWith(1);
    const discardButtons = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Bỏ cả trang');
    act(() => {
      discardButtons[1]!.click();
    });
    expect(onDiscardPage).toHaveBeenCalledWith(3);
  });

  it('click-to-jump navigates the canvas page', () => {
    const onJump = vi.fn();
    renderList({ onJump });
    act(() => {
      (container.querySelector('[data-testid="redact-list-page-3"]') as HTMLButtonElement).click();
    });
    expect(onJump).toHaveBeenCalledWith(3);
  });
});

describe('promotableMarks (the accept filter)', () => {
  it('drops per-row discards from the accept set', () => {
    const out = promotableMarks(PROPOSALS, new Set(['a1', 'b1']), new Set());
    expect(out.map((m) => m.id)).toEqual(['a2']);
  });

  it('kept-flagged pages never promote (plan-skipped pages cannot accept marks)', () => {
    const out = promotableMarks(PROPOSALS, new Set(), new Set([3]));
    expect(out.map((m) => m.id)).toEqual(['a1', 'a2']);
  });

  it('both filters compose (discard + keptFlagged)', () => {
    const out = promotableMarks(PROPOSALS, new Set(['a2']), new Set([3]));
    expect(out.map((m) => m.id)).toEqual(['a1']);
  });
});
