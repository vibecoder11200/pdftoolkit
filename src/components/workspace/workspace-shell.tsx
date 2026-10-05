import type { ReactNode } from 'react';
import { Progress } from '../ui/progress';

interface WorkspaceShellProps {
  title: string;
  meta?: string;
  steps: { label: string; state: 'done' | 'now' | 'todo' }[];
  error?: string | null;
  side: ReactNode;
  children: ReactNode;
  progress?: { value: number; label: string } | null;
  onReset?: () => void;
  onReselectAll?: () => void;
  onNewFiles?: () => void;
}

export function WorkspaceShell({
  title,
  meta,
  steps,
  error,
  side,
  children,
  progress,
  onReset,
  onReselectAll,
  onNewFiles,
}: WorkspaceShellProps) {
  return (
    <div className="mt-3.5 overflow-hidden rounded-2xl border border-border-default bg-surface-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-default px-5.5 py-4">
        <h2 className="text-lg font-bold">{title}</h2>
        {meta ? (
          <span className="text-[13px] text-text-muted tabular-nums">{meta}</span>
        ) : null}
        <div className="flex items-center gap-2 text-xs font-semibold text-text-muted" aria-label="Progress">
          {steps.map((s, i) => (
            <span key={s.label} className="flex items-center gap-1.5">
              {i > 0 ? <span className="h-px w-5 bg-border-default" aria-hidden /> : null}
              <span
                className={`grid h-5 w-5 place-items-center rounded-full border text-[11px] ${
                  s.state === 'done'
                    ? 'border-success bg-success text-text-on-accent'
                    : s.state === 'now'
                      ? 'border-accent bg-accent text-text-on-accent'
                      : 'border-border-strong bg-surface-sunken'
                }`}
              >
                {s.state === 'done' ? '✓' : i + 1}
              </span>
              <span className={s.state === 'now' ? 'text-text-primary' : ''}>{s.label}</span>
            </span>
          ))}
        </div>
        <span className="flex-1" />
        {onNewFiles ? (
          <button type="button" className="min-h-10 text-sm text-text-muted hover:text-text-primary" onClick={onNewFiles}>
            ⟳
          </button>
        ) : null}
      </div>
      <div className="grid min-h-[420px] grid-cols-1 lg:grid-cols-[1fr_280px]">
        <div className="border-b border-border-default px-5 py-4 lg:border-r lg:border-b-0">
          {error ? (
            <div className="mb-3.5 rounded-lg border border-danger bg-danger-soft px-4 py-3 text-[13.5px]" role="alert">
              {error}
            </div>
          ) : null}
          {children}
          {progress ? <Progress value={progress.value} label={progress.label} /> : null}
        </div>
        <aside className="flex flex-col gap-3.5 bg-surface-sunken px-4.5 py-4">{side}</aside>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border-default px-5.5 py-3.5">
        {onReselectAll ? (
          <button
            type="button"
            onClick={onReselectAll}
            className="inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-surface-card px-5 text-sm font-semibold"
          >
            ⟳
          </button>
        ) : null}
        {onReset ? (
          <button type="button" onClick={onReset} className="min-h-10 text-sm text-text-muted hover:text-text-primary">
            ⟲
          </button>
        ) : null}
      </div>
    </div>
  );
}

// token-mapped
