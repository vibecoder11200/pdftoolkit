import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { appendPendingFiles } from '../../lib/handoff';
import { outputFile } from '../../lib/output-file';
import { getPreset } from '../../lib/presets';
import {
  clearPresetSession,
  getPresetSession,
  onPresetSession,
  setPresetStep,
} from '../../lib/preset-session';
import { ArrowRightIcon, CheckIcon, XIcon } from '../ui/icons';

/*
 * In-tool preset chain banner (v0.8.1 phase 4). Rendered by every step host
 * (merge, compress, watermark, page-numbers, encrypt, img-to-pdf, ocr).
 * Shows "Chuỗi: <name> — bước i/n" while the active session stands on THIS
 * tool's step. After the host's successful run (its existing done-state
 * retention passed back as `output`), a "Tiếp tục → <next tool>" button
 * parks the output via appendPendingFiles (NEVER setPendingFiles — REPLACE
 * clobbers a parked OS-launch batch, v0.8.0 finding 5) and walks to the next
 * step; the last step offers "Hoàn thành chuỗi" (clear session, normal done
 * view). The X dismisses the SESSION only — parked files stay consumable.
 * No second retention mechanism: `output` IS the host's useLastOutput value
 * (or the OCR tool's outBytes), already ≤100MB-gated by useLastOutput; the
 * same ceiling is re-checked here so non-LastOutput hosts inherit it.
 */

// useLastOutput parity: outputs above 100MB are never retained anywhere, so
// there is nothing reference-safe to chain — hide the button, keep the info.
const MAX_CHAIN_BYTES = 100 * 1024 * 1024;

export function PresetBanner({
  toolSlug,
  output,
}: {
  toolSlug: string;
  /** The host's current single-PDF output (null until a run succeeds). */
  output: { bytes: Uint8Array; filename: string } | null;
}) {
  // ['common', 'tools'] (v0.8.0 invariant): banner copy lives in common; the
  // NEXT tool's name resolves from the lazy tools namespace — declaring it is
  // what triggers the load, an inline `tools:` prefix alone never does.
  const { t } = useTranslation(['common', 'tools']);
  const navigate = useNavigate();
  const session = useSyncExternalStore(onPresetSession, getPresetSession);

  const preset = session ? getPreset(session.presetSlug) : undefined;
  // Render only on the session's CURRENT step: navigating to some other tool
  // (or an earlier step) shows nothing — the walker stays where it was.
  if (!session || !preset || preset.steps[session.stepIndex] !== toolSlug) return null;

  const stepIndex = session.stepIndex;
  const total = preset.steps.length;
  const isLast = stepIndex === total - 1;
  const nextSlug = isLast ? null : preset.steps[stepIndex + 1];
  const chainable = output !== null && output.bytes.byteLength <= MAX_CHAIN_BYTES;

  const advance = () => {
    if (!chainable || !output || !nextSlug) return;
    appendPendingFiles([outputFile(output.bytes, output.filename)]);
    setPresetStep(stepIndex + 1);
    navigate(`/tools/${nextSlug}`);
  };

  const label = t('presets.banner_step', {
    name: t(`presets.${preset.slug}_name`),
    current: stepIndex + 1,
    total,
  });

  return (
    <section
      aria-label={label}
      data-testid="preset-banner"
      className="mb-3 flex flex-wrap items-center gap-2.5 rounded-xl border-2 border-accent bg-accent-soft px-4 py-3 text-[13.5px]"
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-text-on-accent" aria-hidden>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6h8a4 4 0 0 1 4 4v8" />
          <path d="m13 15 3 3 3-3" />
        </svg>
      </span>
      <strong className="text-sm">{label}</strong>
      {toolSlug === 'ocr' ? (
        // Honesty note (plan Risk): the OCR step can be slow — engine choice
        // and page count are the user's; aborting the session is one click away.
        <span className="text-text-muted">{t('presets.banner_slow_note')}</span>
      ) : null}
      <span className="flex-1" />
      {chainable && nextSlug ? (
        <button
          type="button"
          onClick={advance}
          data-testid="preset-continue"
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent transition hover:-translate-y-px"
        >
          {t('presets.banner_continue', { tool: t(`tools:${nextSlug}.title`) })}
          <ArrowRightIcon size={15} />
        </button>
      ) : null}
      {chainable && isLast ? (
        <button
          type="button"
          onClick={() => clearPresetSession()}
          data-testid="preset-finish"
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-semibold text-text-on-accent transition hover:-translate-y-px"
        >
          <CheckIcon size={14} />
          {t('presets.banner_finish')}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => clearPresetSession()}
        aria-label={t('presets.banner_dismiss')}
        title={t('presets.banner_dismiss')}
        className="grid min-h-9 min-w-9 place-items-center rounded-lg text-text-muted hover:bg-surface-hover hover:text-text-primary"
      >
        <XIcon size={15} />
      </button>
    </section>
  );
}

// token-mapped
