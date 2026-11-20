/**
 * Data loading for screens. `useAsync` fetches on mount / when `deps` change, optionally polls while the screen is
 * focused and the app is in the foreground, ignores stale responses, and keeps showing the previous data while a
 * refresh is in flight (so live numbers never flash to a skeleton).
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { AppState } from 'react-native';

export interface AsyncOptions {
  /** Re-fetch every N ms while the screen is focused and the app is active. */
  intervalMs?: number;
  /** Set false to hold off fetching (e.g. until a prerequisite is known). Default true. */
  enabled?: boolean;
}

export interface AsyncState<T> {
  data: T | undefined;
  /** Last failure, cleared by the next success. Show a blocking error only when `data` is also undefined. */
  error: Error | null;
  /** True until the first response (data or error) arrives. */
  loading: boolean;
  /** Any request in flight (initial, poll or manual). */
  fetching: boolean;
  /** A manual `reload()` (pull to refresh / refresh button) is in flight. */
  refreshing: boolean;
  /** Date.now() of the last successful response. */
  updatedAt: number | null;
  /** Manual refresh: shows `refreshing`. Resolves when done, never throws. */
  reload: () => Promise<void>;
  /** Overwrite the cached data (optimistic updates after a mutation). */
  setData: (next: T | undefined | ((prev: T | undefined) => T | undefined)) => void;
}

export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  options: AsyncOptions = {},
): AsyncState<T> {
  const { intervalMs, enabled = true } = options;
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [fetching, setFetching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);
  const alive = useRef(true);
  const hasData = useRef(false);
  const inFlight = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (kind: 'initial' | 'poll' | 'manual') => {
    const id = ++seq.current;
    inFlight.current += 1;
    setFetching(true);
    if (kind === 'manual') setRefreshing(true);
    try {
      const result = await fetcherRef.current();
      if (!alive.current || id !== seq.current) return;
      hasData.current = true;
      setDataState(result);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (!alive.current || id !== seq.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      inFlight.current -= 1;
      if (alive.current && id === seq.current) {
        setLoading(false);
        setFetching(false);
        setRefreshing(false);
      } else if (alive.current && inFlight.current === 0) {
        setFetching(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Load on mount and whenever deps change (stale data stays visible meanwhile).
  useEffect(() => {
    if (!enabled) return;
    if (!hasData.current) setLoading(true);
    void run('initial');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  // Poll while focused + foregrounded.
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return undefined;
      let timer: ReturnType<typeof setInterval> | null = null;
      let active = AppState.currentState === 'active';
      const stop = () => {
        if (timer) clearInterval(timer);
        timer = null;
      };
      const start = () => {
        stop();
        if (intervalMs && active) timer = setInterval(() => void run('poll'), intervalMs);
      };
      // Coming back to the screen: refresh quietly right away if we already have something on screen.
      if (hasData.current) void run('poll');
      start();
      const sub = AppState.addEventListener('change', (state) => {
        active = state === 'active';
        if (active) {
          if (hasData.current) void run('poll');
          start();
        } else {
          stop();
        }
      });
      return () => {
        stop();
        sub.remove();
      };
    }, [enabled, intervalMs, run]),
  );

  const reload = useCallback(() => run('manual'), [run]);

  const setData = useCallback(
    (next: T | undefined | ((prev: T | undefined) => T | undefined)) => {
      setDataState((prev) => {
        const value = typeof next === 'function' ? (next as (p: T | undefined) => T | undefined)(prev) : next;
        hasData.current = value !== undefined;
        return value;
      });
    },
    [],
  );

  return { data, error, loading, fetching, refreshing, updatedAt, reload, setData };
}
