import type { InputHTMLAttributes } from 'react';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-11 w-full min-w-0 rounded-lg border border-border-strong bg-surface-card px-3.5 text-sm ${props.className ?? ''}`}
    />
  );
}

// token-mapped
