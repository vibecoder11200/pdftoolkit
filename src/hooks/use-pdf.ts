import { useCallback, useEffect, useRef, useState } from 'react';
import { engine } from '../engine/client';
import type { PdfInfo } from '../engine/pdf-lib';

interface PdfState {
  info: PdfInfo | null;
  bytes: Uint8Array | null;
  generation: number;
  loading: boolean;
  error: string | null;
}

export function usePdf() {
  const [state, setState] = useState<PdfState>({
    info: null,
    bytes: null,
    generation: 0,
    loading: false,
    error: null,
  });
  const genRef = useRef(0);

  const load = useCallback(async (bytes: Uint8Array) => {
    const gen = (genRef.current += 1);
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const { info } = await engine.loadPdf(bytes);
      if (genRef.current !== gen) return;
      setState({ info, bytes: bytes.slice(), generation: gen, loading: false, error: null });
    } catch (e) {
      if (genRef.current !== gen) return;
      setState((s) => ({
        ...s,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, []);

  const update = useCallback(async (next: Uint8Array) => {
    const gen = (genRef.current += 1);
    try {
      const { info } = await engine.loadPdf(next);
      if (genRef.current !== gen) return;
      setState({ info, bytes: next.slice(), generation: gen, loading: false, error: null });
    } catch (e) {
      if (genRef.current !== gen) return;
      setState((s) => ({
        ...s,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, []);

  const reset = useCallback(() => {
    genRef.current += 1;
    setState({ info: null, bytes: null, generation: genRef.current, loading: false, error: null });
  }, []);

  useEffect(() => reset, [reset]);

  return { ...state, load, update, reset };
}
