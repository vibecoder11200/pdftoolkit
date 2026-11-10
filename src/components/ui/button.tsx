import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
  /** Shown as a hover/focus tooltip when the button is disabled — native
   * title is swallowed by disabled buttons in several browsers, so the
   * reason rides a wrapping span (UX audit F10). */
  disabledReason?: string;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-text-on-accent hover:bg-accent-hover min-h-11 px-5 text-sm',
  secondary:
    'bg-surface-card border border-border-strong text-text-primary hover:bg-surface-hover min-h-11 px-5 text-sm',
  ghost: 'bg-transparent text-text-muted hover:text-text-primary hover:bg-surface-hover min-h-10 px-4 text-sm',
};

const sizes: Record<Size, string> = {
  md: '',
  sm: 'min-h-9 px-3.5 text-[13px]',
};

export function Button({ variant = 'primary', size = 'md', className = '', disabledReason, ...rest }: ButtonProps) {
  const cls = `${base} ${variants[variant]} ${sizes[size]} ${className}`;
  if (rest.disabled && disabledReason) {
    return (
      <span title={disabledReason} className="inline-flex cursor-not-allowed">
        <button className={cls} disabled {...rest} />
      </span>
    );
  }
  return <button className={cls} {...rest} />;
}

// token-mapped
