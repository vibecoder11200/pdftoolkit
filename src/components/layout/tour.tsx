import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasPendingFiles, onPending } from '../../lib/handoff';
import { Dialog } from '../ui/dialog';

const TOUR_DONE_KEY = 'pdftoolkit-tour-done';
const TOOL_VISITED_KEY = 'pdftoolkit-tool-visited';
const TOUR_REPLAY_KEY = 'pdftoolkit-tour-replay';

export function markToolVisited(): void {
  try {
    sessionStorage.setItem(TOOL_VISITED_KEY, '1');
  } catch {
    /* storage unavailable — tour then just always-eligible, harmless */
  }
}

interface TourStep {
  key: string;
  /** CSS selector for the spotlight target; null = centered welcome card. */
  target: string | null;
}

// Order matters: welcome → universal dropzone → theme toggle → grid.
const STEPS: TourStep[] = [
  { key: 'welcome', target: null },
  { key: 'dropzone', target: '[data-tour="hero-dropzone"]' },
  { key: 'theme', target: '[data-tour="theme-toggle"]' },
  { key: 'grid', target: '[data-tour="tool-grid"]' },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function targetRect(selector: string): Rect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/*
 * First-visit mini tour. Deliberately animation-free: reduced-motion users
 * get the exact same static presentation, and there is no transition logic
 * to break across scroll/resize (the ring re-measures on every step change
 * and window resize; a scrolled-away target simply loses its ring while the
 * centered tooltip stays put).
 *
 * Suppressed when: tour already done, a tool was visited this session, files
 * are pending in the handoff, or an automation driver is attached (Playwright
 * sets navigator.webdriver; tests opt in explicitly via the replay flag).
 */
export function Tour() {
  const { t } = useTranslation();
  const [step, setStep] = useState<number | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const stepRef = useRef<number | null>(null);
  stepRef.current = step;

  const finish = () => {
    try {
      localStorage.setItem(TOUR_DONE_KEY, '1');
    } catch {
      /* ignore */
    }
    setStep(null);
  };
  // Latest-ref so the onPending subscription never resubscribes — every
  // subscribe replays the current handoff, which would re-close the tour.
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    let done = false;
    let replay = false;
    let toolVisited = false;
    try {
      done = localStorage.getItem(TOUR_DONE_KEY) === '1';
      replay = localStorage.getItem(TOUR_REPLAY_KEY) === '1';
      if (replay) localStorage.removeItem(TOUR_REPLAY_KEY);
      toolVisited = sessionStorage.getItem(TOOL_VISITED_KEY) === '1';
    } catch {
      /* storage unavailable */
    }
    const eligible = replay || (!done && !toolVisited && !hasPendingFiles());
    if (!eligible) return;
    if (navigator.webdriver && !replay) return;
    setStep(0);
  }, []);

  // Footer "Quick tour" fires this event when already on home (the flag it
  // also writes only covers the cross-page navigation case).
  useEffect(() => {
    const onReplay = () => setStep(0);
    window.addEventListener('pdftoolkit:tour-replay', onReplay);
    return () => window.removeEventListener('pdftoolkit:tour-replay', onReplay);
  }, []);

  // Files arriving mid-tour (window drop, OS launch) open the suggestion
  // sheet on top of the tour — close instead of stacking two modals. The
  // visit counts as done so the tour does not re-nag.
  useEffect(
    () =>
      onPending(() => {
        if (stepRef.current !== null) finishRef.current();
      }),
    [],
  );

  const current = step !== null ? STEPS[step] : null;

  useLayoutEffect(() => {
    if (current?.target) {
      setRect(targetRect(current.target));
      const onResize = () => setRect(targetRect(current.target!));
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    setRect(null);
  }, [current]);

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  if (step === null || !current) return null;
  const last = step === STEPS.length - 1;

  return (
    <>
      {/* Spotlight ring: one huge box-shadow paints the dimmed overlay. */}
      {rect ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[90] rounded-xl"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: '0 0 0 200vmax var(--surface-overlay)',
          }}
        />
      ) : (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-[90] bg-surface-overlay" />
      )}
      {/* Transparent backdrop: the spotlight ring beneath is the dimmer —
          the default 85% backdrop would re-dim the highlighted target. */}
      <Dialog open onClose={finish} title={t(`tour.${current.key}_title`)} backdropClass="bg-transparent">
        <p className="text-[13.5px] text-text-muted">{t(`tour.${current.key}_body`)}</p>
        <div className="mt-4 flex items-center gap-2">
          <span className="text-xs text-text-muted tabular-nums">
            {step + 1}/{STEPS.length}
          </span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              className="min-h-9 rounded-lg border border-border-strong px-3.5 text-sm"
              onClick={finish}
            >
              {t('tour.skip')}
            </button>
            <button
              type="button"
              className="min-h-9 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent"
              onClick={() => (last ? finish() : setStep(step + 1))}
            >
              {last ? t('tour.finish') : t('tour.next')}
            </button>
          </span>
        </div>
      </Dialog>
    </>
  );
}
