import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type DropzoneProps = {
  title: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  /** Extra classes on the surface (e.g. the large hero variant on home). */
  className?: string;
  /** Optional leading visual (shown above title/hint). */
  icon?: ReactNode;
  /** Denser padding for sidebars / secondary drop targets. */
  compact?: boolean;
  /** Extra actions under the hint (e.g. folder pick). Clicks stay local. */
  footer?: ReactNode;
  onFiles: (files: File[]) => void;
} & Record<string, unknown>;

export function Dropzone({
  title,
  hint,
  accept,
  multiple = true,
  className = '',
  icon,
  compact = false,
  footer,
  onFiles,
  ...rest
}: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const dragActive = dragDepth > 0;

  const emit = useCallback(
    (list: FileList | File[]) => {
      onFiles(Array.from(list));
    },
    [onFiles],
  );

  return (
    <>
      <div
        className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed text-center text-[13.5px] transition-[border-color,background-color,transform] ${
        compact ? 'px-3 py-2.5' : 'px-4 py-3'
      } ${
        dragActive
          ? 'scale-[1.01] border-accent bg-accent-soft'
          : 'border-border-strong text-text-muted'
      } ${className}`}
      role="button"
      tabIndex={0}
      aria-label={title}
      {...rest}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        if (Array.from(e.dataTransfer.types).includes('Files')) setDragDepth((d) => d + 1);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => {
        e.preventDefault();
        setDragDepth(0);
        if (e.dataTransfer.files.length > 0) emit(e.dataTransfer.files);
      }}
    >
      {icon ? (
        <span className={dragActive ? 'text-accent' : 'text-text-muted'} aria-hidden>
          {icon}
        </span>
      ) : null}
      <strong className="text-text-primary">{title}</strong>
      <span>{hint}</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files) emit(e.target.files);
          e.target.value = '';
        }}
      />
      </div>
      {/* Secondary actions stay OUTSIDE the role="button" surface — nesting
          an interactive control inside another is an axe violation. */}
      {footer ? <div className="mt-1.5">{footer}</div> : null}
    </>
  );
}

// token-mapped
