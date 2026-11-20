/**
 * A minimal loader for the connect component. `useAsync` (src/hooks.ts) also subscribes to screen focus, which needs a
 * navigation context; the connect sheet is rendered by a provider outside every screen, so this one has none.
 */
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export interface Loader<T> {
  data: T | undefined;
  error: Error | null;
  /** True until the first answer (data or error). */
  loading: boolean;
  /** Fetch again; never throws. Keeps showing the previous data meanwhile. */
  reload: () => Promise<void>;
  /** Replace the data (an optimistic update after a save). */
  setData: (next: T | undefined | ((prev: T | undefined) => T | undefined)) => void;
}

export function useLoader<T>(fetcher: () => Promise<T>, deps: DependencyList = []): Loader<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const id = ++seq.current;
    try {
      const result = await fetcherRef.current();
      if (!alive.current || id !== seq.current) return;
      setData(result);
      setError(null);
    } catch (e) {
      if (!alive.current || id !== seq.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (alive.current && id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);

  return { data, error, loading, reload, setData };
}
