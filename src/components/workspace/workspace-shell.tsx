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
    <div className="mt-3.5 overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5.5 py-4">
        <h2 className="text-lg font-bold">{title}</h2>
        {meta ? (
          <span className="text-[13px] text-slate-500 tabular-nums">{meta}</span>
        ) : null}
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-500" aria-label="Progress">
          {steps.map((s, i) => (
            <span key={s.label} className="flex items-center gap-1.5">
              {i > 0 ? <span className="h-px w-5 bg-slate-200" aria-hidden /> : null}
              <span
                className={`grid h-5 w-5 place-items-center rounded-full border text-[11px] ${
                  s.state === 'done'
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : s.state === 'now'
                      ? 'border-indigo-600 bg-indigo-600 text-white'
                      : 'border-slate-300 bg-slate-100'
                }`}
              >
                {s.state === 'done' ? '✓' : i + 1}
              </span>
              <span className={s.state === 'now' ? 'text-slate-900' : ''}>{s.label}</span>
            </span>
          ))}
        </div>
        <span className="flex-1" />
        {onNewFiles ? (
          <button type="button" className="min-h-10 text-sm text-slate-500 hover:text-slate-900" onClick={onNewFiles}>
            ⟳
          </button>
        ) : null}
      </div>
      <div className="grid min-h-[420px] grid-cols-1 lg:grid-cols-[1fr_280px]">
        <div className="border-b border-slate-200 px-5 py-4 lg:border-r lg:border-b-0">
          {error ? (
            <div className="mb-3.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13.5px]" role="alert">
              {error}
            </div>
          ) : null}
          {children}
          {progress ? <Progress value={progress.value} label={progress.label} /> : null}
        </div>
        <aside className="flex flex-col gap-3.5 bg-slate-100 px-4.5 py-4">{side}</aside>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-5.5 py-3.5">
        {onReselectAll ? (
          <button
            type="button"
            onClick={onReselectAll}
            className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-5 text-sm font-semibold"
          >
            ⟳
          </button>
        ) : null}
        {onReset ? (
          <button type="button" onClick={onReset} className="min-h-10 text-sm text-slate-500 hover:text-slate-900">
            ⟲
          </button>
        ) : null}
      </div>
    </div>
  );
}
