import type { InputHTMLAttributes } from 'react';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3.5 text-sm ${props.className ?? ''}`}
    />
  );
}
