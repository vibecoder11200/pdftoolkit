export function Progress({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div
        className="mt-3 h-2 overflow-hidden rounded-full border border-slate-200 bg-slate-100"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="h-full bg-indigo-600 transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-[13px] text-slate-500">{label}</p>
    </div>
  );
}
