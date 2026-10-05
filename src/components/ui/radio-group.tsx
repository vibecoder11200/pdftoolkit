import type { ReactNode } from 'react';

interface RadioCardProps {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  hint?: string;
  children?: ReactNode;
}

export function RadioGroup({ children }: { children: ReactNode }) {
  return <div role="radiogroup">{children}</div>;
}

export function RadioCard({ name, checked, onChange, title, hint }: RadioCardProps) {
  return (
    <label className="mb-2 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border-default bg-surface-card p-2.5 text-[13.5px] has-checked:border-accent has-checked:ring-1 has-checked:ring-accent">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="mt-1 min-h-[18px] min-w-[18px] accent-accent"
      />
      <span>
        {title}
        {hint ? <small className="block text-text-muted">{hint}</small> : null}
      </span>
    </label>
  );
}

// token-mapped
