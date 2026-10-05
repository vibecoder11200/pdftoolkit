import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const CONCURRENCY = 4;
/** Start rendering slightly before the thumbnail scrolls into view. */
const VIEWPORT_MARGIN = '300px';

// One shared import for all in-flight renders: parallel dynamic import()
// calls of the same module resolve on different ticks under test runners,
// which would stall the concurrency pump.
let rendererPromise: Promise<typeof import('../engine/pdfjs')> | null = null;
function loadRenderer() {
  rendererPromise ??= import('../engine/pdfjs');
  return rendererPromise;
}

/** One renderable thumbnail. `id` and `version` together identify the
 * image: same id + new version (rotated/deleted-then-reloaded document)
 * re-renders; same both (reorder) keeps the cached blob URL. */
export interface ThumbJob {
  id: string;
  bytes: Uint8Array;
  page: number;
  version?: number | string;
}

interface Entry {
  url: string;
  version: number | string;
}

/**
 * Lazy thumbnail pipeline (phase 2): a page renders only when its element
 * enters the viewport, at most CONCURRENCY renders run at once, and stale
 * generations are dropped. Keys are stable ids — never display positions —
 * so reordering while renders are pending cannot mispaint.
 */
export function useThumbnails(jobs: ThumbJob[], scale = 0.4) {
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const elementsRef = useRef(new Map<string, HTMLElement>());
  const abortRef = useRef<AbortController | null>(null);
  const pumpRef = useRef<() => void>(() => {});
  const ioRef = useRef<IntersectionObserver | null>(null);
  const queueRef = useRef<Set<string>>(new Set());
  const inflightRef = useRef(0);

  const jobOf = useCallback(
    (id: string) => jobsRef.current.find((j) => j.id === id) ?? null,
    [],
  );
  const isFresh = useCallback((id: string) => {
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job) return false;
    const version = job.version ?? 0;
    const entry = entriesRef.current[id];
    return entry !== undefined && entry.version === version;
  }, []);

  // One observer for the hook's lifetime. Ref-callbacks register elements as
  // ThumbnailStrip mounts them, so this must not live inside an effect pass.
  if (ioRef.current === null && typeof IntersectionObserver !== 'undefined') {
    ioRef.current = new IntersectionObserver(
      (ioEntries) => {
        for (const e of ioEntries) {
          if (!e.isIntersecting) continue;
          const io = ioRef.current;
          if (io) io.unobserve(e.target);
          const id = (e.target as HTMLElement).dataset.thumbId;
          if (!id || isFresh(id)) continue;
          queueRef.current.add(id);
          pumpRef.current();
        }
      },
      { rootMargin: VIEWPORT_MARGIN },
    );
  }

  // Generation boundary: whenever the id/version signature changes, abort
  // in-flight work, revoke blob URLs that are gone or stale, and re-arm
  // visibility for thumbnails that still need a render (this is what keeps
  // reorder-during-pending from wedging the queue).
  const signature = jobs.map((j) => `${j.id}@${j.version ?? 0}`).join('\n');
  useEffect(() => {
    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;

    setEntries((prev) => {
      let changed = false;
      const next: Record<string, Entry> = {};
      for (const [id, entry] of Object.entries(prev)) {
        const job = jobsRef.current.find((j) => j.id === id);
        if (job && entry.version === (job.version ?? 0)) next[id] = entry;
        else {
          changed = true;
          URL.revokeObjectURL(entry.url);
        }
      }
      return changed ? next : prev;
    });

    const io = ioRef.current;
    if (io) {
      for (const [id, el] of elementsRef.current) {
        if (!isFresh(id)) io.observe(el);
      }
    }

    pumpRef.current = () => {
      while (!abort.signal.aborted && inflightRef.current < CONCURRENCY) {
        const [id] = queueRef.current;
        if (id === undefined) return;
        queueRef.current.delete(id);
        const job = jobsRef.current.find((j) => j.id === id);
        if (!job || isFresh(id)) continue;
        inflightRef.current += 1;
        void (async () => {
          try {
            // Lazy: keeps the 400KB+ pdf.js chunk out of the initial bundle.
            const { renderPageToCanvas } = await loadRenderer();
            const canvas = document.createElement('canvas');
            await renderPageToCanvas(job.bytes, job.page, canvas, scaleRef.current);
            const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
            if (abort.signal.aborted || !blob) return;
            const version = job.version ?? 0;
            const url = URL.createObjectURL(blob);
            setEntries((prev) => {
              const stillThere = jobsRef.current.some((j) => j.id === id);
              if (!stillThere) {
                URL.revokeObjectURL(url);
                return prev;
              }
              const old = prev[id];
              if (old) URL.revokeObjectURL(old.url);
              return { ...prev, [id]: { url, version } };
            });
          } catch {
            /* keep placeholder */
          } finally {
            inflightRef.current -= 1;
            pumpRef.current();
          }
        })();
      }
    };

    return () => {
      abort.abort();
      queueRef.current.clear();
    };
  }, [signature, isFresh]);

  useEffect(
    () => () => {
      ioRef.current?.disconnect();
      for (const entry of Object.values(entriesRef.current)) URL.revokeObjectURL(entry.url);
    },
    [],
  );

  const observe = useCallback((id: string, el: HTMLElement | null) => {
    if (!el) return undefined;
    el.dataset.thumbId = id;
    elementsRef.current.set(id, el);
    ioRef.current?.observe(el);
    return () => {
      elementsRef.current.delete(id);
      const io = ioRef.current;
      if (io) io.unobserve(el);
    };
  }, []);

  return useMemo(
    () => ({
      urlFor: (id: string) => (isFresh(id) ? entriesRef.current[id].url : null),
      observe,
      jobOf,
    }),
    [observe, isFresh, jobOf],
  );
}
