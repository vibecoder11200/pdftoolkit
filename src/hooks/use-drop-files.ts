import { useCallback, useState } from 'react';
import { MAX_FILE_BYTES, checkPdfFile } from '../lib/file-accept';

export interface DroppedFile {
  file: File;
  bytes: Uint8Array;
}

export function useDropFiles() {
  const [files, setFiles] = useState<DroppedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(async (incoming: File[]) => {
    setError(null);
    const next: DroppedFile[] = [];
    for (const file of incoming) {
      if (file.size > MAX_FILE_BYTES) {
        setError(`too-large:${file.name}`);
        continue;
      }
      const verdict = await checkPdfFile(file);
      if (!verdict.ok) {
        setError(`${verdict.reason}:${file.name}`);
        continue;
      }
      next.push({ file, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    if (next.length > 0) setFiles((prev) => [...prev, ...next]);
  }, []);

  const removeAt = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clear = useCallback(() => setFiles([]), []);

  return { files, error, add, removeAt, clear };
}
