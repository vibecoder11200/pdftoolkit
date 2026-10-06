import type { ReactNode } from 'react';

/*
 * Shared stroke icon set (24×24, currentColor, aria-hidden by default).
 * Replaces the emoji/glyph symbols that used to be scattered across tools.
 * Every icon-only button must still carry its own i18n aria-label.
 */
function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function FileIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </Icon>
  );
}

export function XIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

export function RefreshIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" />
    </Icon>
  );
}

export function ResetIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
    </Icon>
  );
}

export function MenuIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M3 6h18M3 12h18M3 18h18" />
    </Icon>
  );
}

export function LockIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

export function DownloadIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5M12 15V3" />
    </Icon>
  );
}

export function PlusIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function AlertTriangleIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Icon>
  );
}

export function CheckCircleIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4 12 14.01l-3-3" />
    </Icon>
  );
}

export function InfoIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </Icon>
  );
}

export function ExpandIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
    </Icon>
  );
}

export function CheckIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

export function ArrowRightIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M5 12h14m-5-5 5 5-5 5" />
    </Icon>
  );
}
