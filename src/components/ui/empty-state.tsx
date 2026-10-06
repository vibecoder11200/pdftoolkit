import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  hint,
  action,
  muted = false,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  /** Softened look for "coming soon" spots (e.g. /tools/convert). */
  muted?: boolean;
}) {
  return (
    <div className="grid place-items-center gap-2 px-6 py-14 text-center">
      {icon ? (
        <span className={muted ? 'text-text-muted/50' : 'text-accent'} aria-hidden>
          {icon}
        </span>
      ) : null}
      <p className={`text-base font-bold ${muted ? 'text-text-muted' : ''}`}>{title}</p>
      {hint ? <p className="max-w-[46ch] text-[13.5px] text-text-muted">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
