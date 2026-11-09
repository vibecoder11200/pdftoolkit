import { useTranslation } from 'react-i18next';
import type { RedactMark } from '../../lib/redact-pipeline';
import type { SearchProposal } from './editor-tool';

/*
 * Redact keyword-search review list (v0.10.2 phase 3, plan 261109-1101 —
 * pays the v0.10.0 F12 deferral). A REVIEW affordance, not a second
 * marking surface: rows are read-only (no mark editing, no drag); the
 * only mutations are keep/discard (per row), accept/discard-all (per
 * page), and click-to-jump (the canvas stays the source of truth — the
 * list navigates and selects, the canvas positions).
 *
 * Rendered grouped by ascending page; each row shows the run-text excerpt
 * captured at proposal creation time (≤60 chars, ellipsized) with a
 * keep/discard toggle. Applies compose into `marks` exactly as the old
 * accept-all did — the apply path (runRedactionPipeline) is untouched.
 */

const EXCERPT_MAX = 60;

/**
 * The promote filter behind "Chấp nhận tất cả" (pure, spec-pinned): drops
 * per-row discards and proposals on kept-flagged pages (kept pages are
 * EXCLUDED from the redaction plan by design — promoting them would show
 * solid boxes that silently do nothing). The apply path itself is
 * untouched: whatever survives composes into `marks` via
 * dedupeProposals, and runRedactionPipeline stays the only composer.
 */
export function promotableMarks(
  proposals: SearchProposal[],
  discardedIds: Set<string>,
  keptFlagged: Set<number>,
): RedactMark[] {
  return proposals
    .filter((pr) => !keptFlagged.has(pr.mark.page) && !discardedIds.has(pr.mark.id))
    .map((pr) => pr.mark);
}

interface RedactReviewListProps {
  proposals: SearchProposal[];
  discardedIds: Set<string>;
  currentPage: number;
  onToggle: (id: string) => void;
  onAcceptPage: (page: number) => void;
  onDiscardPage: (page: number) => void;
  onJump: (page: number) => void;
}

export function RedactReviewList({
  proposals,
  discardedIds,
  currentPage,
  onToggle,
  onAcceptPage,
  onDiscardPage,
  onJump,
}: RedactReviewListProps) {
  const { t } = useTranslation('common');
  const pages = [...new Set(proposals.map((pr) => pr.mark.page))].sort((a, b) => a - b);

  return (
    <div
      data-testid="redact-review-list"
      className="mt-2 flex flex-col gap-2 rounded-lg border border-border-default p-2.5"
    >
      <p className="text-sm font-bold">{t('redact.list_title')}</p>
      {pages.map((page) => {
        const rows = proposals.filter((pr) => pr.mark.page === page);
        const kept = rows.filter((pr) => !discardedIds.has(pr.mark.id));
        return (
          <div key={page} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => onJump(page)}
                className="min-h-8 text-[13px] font-semibold text-accent hover:underline"
                data-testid={`redact-list-page-${page}`}
              >
                {t('redact.list_page', { page, count: rows.length })}
                {page === currentPage ? ' ·' : ''}
              </button>
              <span className="flex gap-1">
                <button
                  type="button"
                  onClick={() => onAcceptPage(page)}
                  className={`min-h-8 rounded-md border px-2.5 text-[12.5px] font-semibold ${
                    kept.length === rows.length
                      ? 'border-accent bg-accent-soft'
                      : 'border-border-strong text-text-muted'
                  }`}
                >
                  {t('redact.list_accept_page')}
                </button>
                <button
                  type="button"
                  onClick={() => onDiscardPage(page)}
                  className={`min-h-8 rounded-md border px-2.5 text-[12.5px] font-semibold ${
                    kept.length === 0 ? 'border-accent bg-accent-soft' : 'border-border-strong text-text-muted'
                  }`}
                >
                  {t('redact.list_discard_page')}
                </button>
              </span>
            </div>
            <ul className="flex flex-col gap-1">
              {rows.map((pr) => {
                const discarded = discardedIds.has(pr.mark.id);
                const excerpt =
                  pr.excerpt.length > EXCERPT_MAX ? `${pr.excerpt.slice(0, EXCERPT_MAX)}…` : pr.excerpt;
                return (
                  <li key={pr.mark.id} className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onToggle(pr.mark.id)}
                      aria-pressed={!discarded}
                      data-testid="redact-list-row"
                      className={`min-h-8 flex-1 truncate rounded-md border px-2.5 py-1 text-left text-[12.5px] ${
                        discarded
                          ? 'border-border-strong text-text-muted line-through opacity-60'
                          : 'border-border-default'
                      }`}
                    >
                      {excerpt}
                    </button>
                    <span className="w-16 shrink-0 text-right text-[12px] text-text-muted">
                      {discarded ? t('redact.list_discard') : t('redact.list_keep')}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
