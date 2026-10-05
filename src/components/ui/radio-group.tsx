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
    <label className="mb-2 flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 bg-white p-2.5 text-[13.5px] has-checked:border-indigo-600 has-checked:ring-1 has-checked:ring-indigo-600">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="mt-1 min-h-[18px] min-w-[18px] accent-indigo-600"
      />
      <span>
        {title}
        {hint ? <small className="block text-slate-500">{hint}</small> : null}
      </span>
    </label>
  );
}
