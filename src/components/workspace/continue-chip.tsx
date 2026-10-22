import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { appendPendingFiles } from '../../lib/handoff';
import { outputFile } from '../../lib/output-file';
import { TOOLS } from '../layout/tool-card';
import { Dialog } from '../ui/dialog';

/*
 * "Tiếp tục với kết quả" chaining chip (v0.8.0 phase 4; builder variant
 * v0.8.1 phase 5). Rendered in a tool's done view after a successful
 * single-PDF-output run. Two modes:
 *  - bytes+filename: the usual retained-output host (≤100MB retention rule);
 *  - builder: click-time construction for hosts whose bytes do not exist
 *    until wanted (the OCR AI sandwich — v0.7.0 "nothing retained"
 *    invariant; nothing is held before the user picks a target).
 * Target picker = PDF-intake tools that consume pending files (the ToolDef
 * `acceptsPdf` flag — since v0.8.1 that includes ocr, which now takes
 * pending files at mount; img-to-pdf still carries no flag), minus the
 * CURRENT tool (same-path navigation = no remount = no take). On pick:
 * construct the File from the output bytes, PARK via appendPendingFiles —
 * NEVER setPendingFiles, whose REPLACE semantics would clobber a parked
 * OS-launch batch — then navigate; the target tool's existing mount-time
 * takePendingFiles() loads it through its normal validated intake.
 */

export function ContinueChip({
  bytes,
  filename,
  builder,
}: {
  bytes?: Uint8Array;
  filename?: string;
  builder?: () => Promise<{ bytes: Uint8Array; filename: string }>;
}) {
  // The `tools` namespace is NOT loaded on tool pages (only the home grid
  // declares it) — declaring it here is what makes the picker titles resolve;
  // an inline `tools:` prefix alone never triggers the lazy load + rerender.
  const { t } = useTranslation(['common', 'tools']);
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [building, setBuilding] = useState(false);

  const currentSlug = useMemo(() => {
    const m = /\/tools\/([^/]+)/.exec(location.pathname);
    return m ? m[1] : '';
  }, [location.pathname]);

  const targets = useMemo(
    () => TOOLS.filter((tool) => tool.acceptsPdf && tool.slug !== currentSlug),
    [currentSlug],
  );

  const go = async (slug: string) => {
    let outBytes = bytes;
    let outName = filename;
    setOpen(false);
    if (!outBytes && builder) {
      setBuilding(true);
      try {
        const built = await builder();
        outBytes = built.bytes;
        outName = built.filename;
      } catch {
        // Build failure is surfaced by the host's own error banner; the
        // chip stays put for a retry instead of rejecting through the
        // onClick arrow (unhandled rejection).
        return;
      } finally {
        setBuilding(false);
      }
    }
    if (!outBytes || !outName) return;
    appendPendingFiles([outputFile(outBytes, outName)]);
    navigate(`/tools/${slug}`);
  };

  return (
    <>
      <button
        type="button"
        disabled={building}
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border-2 border-accent bg-accent-soft px-4 text-sm font-semibold text-text-primary transition hover:-translate-y-px disabled:opacity-50"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12h14m0 0-5-5m5 5-5 5" />
        </svg>
        {t('chip.chip_label')}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('chip.chip_title')}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {targets.map((tool) => (
            <button
              key={tool.slug}
              type="button"
              onClick={() => go(tool.slug)}
              className="flex min-h-10 items-center gap-2 rounded-lg border border-border-default px-3 py-2 text-left text-[13px] font-semibold hover:border-accent"
            >
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${tool.tone}`} aria-hidden>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d={tool.icon} />
                </svg>
              </span>
              {t(`tools:${tool.slug}.title`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-4 min-h-10 rounded-lg border border-border-strong px-4 text-sm font-semibold"
        >
          {t('chip.chip_cancel')}
        </button>
      </Dialog>
    </>
  );
}

// token-mapped
