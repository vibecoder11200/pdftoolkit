import { useEffect, useRef, useState } from 'react';
import { renderPageToCanvas } from '../engine/pdfjs';

const CONCURRENCY = 4;

export function useThumbnails(bytes: Uint8Array | null, pageCount: number, generation: number) {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setUrls(Array.from({ length: pageCount }, () => null));
    if (!bytes || pageCount === 0) return;
    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;
    const gen = generation;
    let next = 1;
    let active = 0;
    let done = false;

    const pump = () => {
      if (abort.signal.aborted || done) return;
      while (active < CONCURRENCY && next <= pageCount) {
        const n = next;
        next += 1;
        active += 1;
        void (async () => {
          try {
            const canvas = document.createElement('canvas');
            await renderPageToCanvas(bytes, n, canvas, 0.5);
            if (abort.signal.aborted) return;
            const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
            if (!blob || abort.signal.aborted) return;
            const url = URL.createObjectURL(blob);
            setUrls((prev) => {
              if (gen !== generation) {
                URL.revokeObjectURL(url);
                return prev;
              }
              const copy = [...prev];
              if (copy[n - 1]) URL.revokeObjectURL(copy[n - 1]!);
              copy[n - 1] = url;
              return copy;
            });
          } catch {
            /* keep placeholder */
          } finally {
            active -= 1;
            if (next > pageCount && active === 0) done = true;
            else pump();
          }
        })();
      }
    };
    pump();

    return () => {
      abort.abort();
      setUrls((prev) => {
        for (const u of prev) if (u) URL.revokeObjectURL(u);
        return Array.from({ length: pageCount }, () => null);
      });
    };
  }, [bytes, pageCount, generation]);

  return urls;
}
