import { useCallback, useRef } from 'react';

interface DropzoneProps {
  title: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
}

export function Dropzone({ title, hint, accept, multiple = true, onFiles }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const emit = useCallback(
    (list: FileList | File[]) => {
      onFiles(Array.from(list));
    },
    [onFiles],
  );

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2.5 rounded-lg border-2 border-dashed border-border-strong px-4 py-3 text-center text-[13.5px] text-text-muted"
      role="button"
      tabIndex={0}
      aria-label={title}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) emit(e.dataTransfer.files);
      }}
    >
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
  );
}

// token-mapped
