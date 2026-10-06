import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Dialog } from '../ui/dialog';
import { formatBytes } from '../../lib/format';
import { setPendingFiles } from '../../lib/handoff';
import { TOOLS } from './tool-card';
import type { SuggestResult, Suggestion } from '../../lib/suggest';

export interface SheetState {
  files: File[];
  result: SuggestResult;
}

/**
 * Ranked tool suggestions for the dropped files. Picking a row hands the
 * still-unread File handles to the handoff store and navigates; the tool
 * page consumes them through its normal validated intake.
 */
export function SuggestionSheet({ state, onClose }: { state: SheetState; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [singleFileNote, setSingleFileNote] = useState<string | null>(null);
  const totalSize = formatBytes(state.files.reduce((sum, f) => sum + f.size, 0));

  const go = (slug: string, mode?: Suggestion['mode']) => {
    setPendingFiles(state.files, mode ? { mode } : undefined);
    navigate(`/tools/${slug}`);
  };

  return (
    <Dialog open onClose={onClose} title={t('home.sheet_title', { count: state.files.length })}>
      <p className="text-[13px] text-text-muted tabular-nums">
        {t('home.files_line', { count: state.files.length, size: totalSize })}
      </p>

      <div className="mt-3 flex flex-col gap-2.5">
        {state.result.suggestions.map((s) => (
          <button
            key={`${s.slug}:${s.mode ?? ''}`}
            type="button"
            onClick={() => go(s.slug, s.mode)}
            className="flex min-h-14 items-center gap-3 rounded-xl border-2 border-accent bg-accent-soft px-4 py-3 text-left transition hover:-translate-y-px"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent" aria-hidden>
              <path d="M5 12h14m0 0-5-5m5 5-5 5" />
            </svg>
            <span>
              <strong className="block text-sm font-bold">{t(`tools:${s.slug}.title`)}</strong>
              <span className="text-[13px] text-text-muted">{t(s.reasonKey)}</span>
            </span>
          </button>
        ))}
        {state.result.rejected.map((r) => (
          <p key={r.name} className="rounded-lg border border-border-default px-4 py-2.5 text-[13px] text-text-muted">
            <strong className="text-text-primary">{r.name}</strong> — {t(`home.reject_${r.reason}`)}
          </p>
        ))}
      </div>

      {state.result.showAllTools ? (
        <div className="mt-4">
          <h3 className="text-xs font-bold tracking-[0.08em] text-text-muted uppercase">{t('home.all_tools')}</h3>
          {singleFileNote ? (
            <p className="mt-2 rounded-lg border border-border-default bg-surface-page px-3 py-2 text-[13px]" role="status">
              {singleFileNote}
            </p>
          ) : null}
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {TOOLS.map((tool) => {
              // Ranked suggestions above are curated (e.g. compress legitimately
              // takes the PDF out of a pdf+image set). This grid is the uncurated
              // path — a single-file tool would silently drop files 2..N, so it
              // explains itself instead of navigating.
              const blocked = state.files.length > 1 && !tool.multiFile;
              return (
                <button
                  key={tool.slug}
                  type="button"
                  aria-label={blocked ? t('home.sheet_single_file_aria', { tool: t(`tools:${tool.slug}.title`) }) : undefined}
                  onClick={() => {
                    if (blocked) {
                      setSingleFileNote(t('home.sheet_single_file_note', { tool: t(`tools:${tool.slug}.title`) }));
                      return;
                    }
                    go(tool.slug);
                  }}
                  className="flex min-h-10 items-center gap-2 rounded-lg border border-border-default px-3 py-2 text-left text-[13px] font-semibold hover:border-accent"
                >
                  {t(`tools:${tool.slug}.title`)}
                  {blocked ? <span className="ml-auto rounded-full border border-border-strong px-1.5 text-[11px] font-normal text-text-muted">1</span> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onClose}
        className="mt-4 min-h-10 rounded-lg border border-border-strong px-4 text-sm font-semibold"
      >
        {t('home.sheet_close')}
      </button>
    </Dialog>
  );
}
