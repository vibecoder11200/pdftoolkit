import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Dialog } from '../ui/dialog';

const GUIDE_SEEN_KEY = 'pdftoolkit-guide-seen';
const TOOL_VISITED_KEY = 'pdftoolkit-tool-visited';

/**
 * First-visit welcome + on-demand quick guide (v0.5.2 redesign of the old
 * 4-step spotlight tour). The tour failed three ways in the field: it dimmed
 * the whole page behind a modal spotlight ("che lấp"), its step targets
 * drifted from the real UI, and the footer replay path deleted the done
 * flag — abandon the tour once after that click and it re-activated on
 * EVERY launch. The replacement never auto-blocks: the first-visit bit is a
 * small inline strip in the hero (worst case it shows again, it can never
 * cover anything), and the guide itself only opens on explicit user action.
 */

export function markGuideSeen(): void {
  try {
    localStorage.setItem(GUIDE_SEEN_KEY, '1');
  } catch {
    /* storage unavailable — the strip is non-blocking, so a re-show is fine */
  }
}

function wasGuideSeen(): boolean {
  try {
    return localStorage.getItem(GUIDE_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markToolVisited(): void {
  try {
    sessionStorage.setItem(TOOL_VISITED_KEY, '1');
  } catch {
    /* storage unavailable — strip stays eligible, harmless */
  }
}

function toolVisitedThisSession(): boolean {
  try {
    return sessionStorage.getItem(TOOL_VISITED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Footer/home "Hướng dẫn nhanh" — opens the guide where it is mounted. */
export function openQuickGuide(): void {
  window.dispatchEvent(new Event('pdftoolkit:quick-guide'));
}

interface GuideSection {
  key: string;
  /** Route to link to; a section without one is plain copy. */
  to?: string;
  /** Locale key of the link label (only when `to` is set). */
  link?: string;
}

const SECTIONS: GuideSection[] = [
  { key: 'start' },
  { key: 'tools', to: '/', link: 'tools_link' },
  { key: 'ai', to: '/tools/ocr', link: 'ai_link' },
  { key: 'privacy' },
  { key: 'settings', to: '/settings', link: 'settings_link' },
  { key: 'desktop' },
];

/** Non-blocking first-visit strip. Renders nothing once dismissed or after
 *  any tool visit this session (the old tour's suppression contract). */
export function GuideWelcome() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(!wasGuideSeen() && !toolVisitedThisSession());
  }, []);
  if (!visible) return null;
  const dismiss = () => {
    markGuideSeen();
    setVisible(false);
  };
  return (
    <div
      data-testid="guide-welcome"
      className="mx-auto mt-4 flex max-w-2xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border-strong bg-surface-card px-4 py-3 text-left"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{t('guide.welcome_title')}</p>
        <p className="text-[13px] text-text-muted">{t('guide.welcome_body')}</p>
      </div>
      <button
        type="button"
        data-testid="guide-open"
        className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
        onClick={() => {
          dismiss();
          openQuickGuide();
        }}
      >
        {t('guide.welcome_open')}
      </button>
      <button
        type="button"
        data-testid="guide-dismiss"
        aria-label={t('guide.welcome_dismiss')}
        className="grid min-h-9 min-w-9 place-items-center rounded-lg border border-border-strong px-2 text-sm"
        onClick={dismiss}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * The quick guide dialog. Mounted once at the router root (banners row) so
 * the footer button works on every page; opens ONLY via openQuickGuide() —
 * never on its own.
 */
export function QuickGuide() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('pdftoolkit:quick-guide', onOpen);
    return () => window.removeEventListener('pdftoolkit:quick-guide', onOpen);
  }, []);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title={t('guide.title')}>
      <div className="grid gap-3 sm:grid-cols-2">
        {SECTIONS.map((s) => (
          <section key={s.key} className="rounded-lg border border-border-default bg-surface-card p-3">
            <h3 className="text-sm font-bold">{t(`guide.${s.key}_title`)}</h3>
            <p className="mt-1 text-[13px] text-text-muted">{t(`guide.${s.key}_body`)}</p>
            {s.to ? (
              <Link
                data-testid={`guide-link-${s.key}`}
                to={s.to}
                onClick={() => setOpen(false)}
                className="mt-2 inline-block text-[13px] font-semibold text-accent hover:underline"
              >
                {t(`guide.${s.link}`)} →
              </Link>
            ) : null}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
