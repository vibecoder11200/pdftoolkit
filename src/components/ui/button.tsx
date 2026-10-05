import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'md' | 'sm';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2';

const variants: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 min-h-11 px-5 text-sm',
  secondary:
    'bg-white border border-slate-300 text-slate-900 hover:bg-slate-100 min-h-11 px-5 text-sm',
  ghost: 'bg-transparent text-slate-500 hover:text-slate-900 hover:bg-slate-100 min-h-10 px-4 text-sm',
};

const sizes: Record<Size, string> = {
  md: '',
  sm: 'min-h-9 px-3.5 text-[13px]',
};

export function Button({ variant = 'primary', size = 'md', className = '', ...rest }: ButtonProps) {
  return <button className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...rest} />;
}
