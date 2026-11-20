/**
 * React glue for the autopilot config: the server copy (`useAsync`, polled) + the local overlay of unconfirmed edits +
 * the autosave engine from `autopilot-logic.tsx`. The screen reads `cfg` (server + overlay) and calls `edit`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, ApiError } from '@/src/api';
import { useAsync } from '@/src/hooks';
import type { AutopilotConfig, AutopilotRun } from '@/src/types';
import { useToast } from '@/src/ui';
import { ConfigSaver, type Overlay } from './autopilot-logic';

/** How often the config is re-read while the Settings tab is on screen: keeps "Last run" and outside changes live. */
const POLL_MS = 10_000;

export const messageOf = (e: unknown): string => (e instanceof ApiError ? e.message : 'Something went wrong');

export function useAutopilotConfig() {
  const { show } = useToast();
  const showRef = useRef(show);
  showRef.current = show;

  const [overlay, setOverlay] = useState<Overlay>({});
  const [savedAt, setSavedAt] = useState(0);
  const setDataRef = useRef<(next: AutopilotConfig) => void>(() => undefined);

  const saverRef = useRef<ConfigSaver | null>(null);
  if (saverRef.current === null) {
    saverRef.current = new ConfigSaver({
      put: (body) => api.putAutopilot(body),
      serverChanged: (next) => setDataRef.current(next),
      overlayChanged: (next) => setOverlay(next),
      saved: () => setSavedAt(Date.now()),
      failed: (e) => showRef.current(messageOf(e), 'error'),
    });
  }
  const saver = saverRef.current;

  const { data, error, loading, refreshing, reload, setData } = useAsync(
    async () => {
      // A poll that overlapped one of our writes may predate it: keep what we have instead of rolling the UI back.
      const token = saver.pollToken();
      const fresh = await api.getAutopilot();
      return saver.isStale(token) && saver.server ? saver.server : fresh;
    },
    [],
    { intervalMs: POLL_MS },
  );
  setDataRef.current = setData;
  // Synced during render on purpose: the fetcher above must already see a PUT's result when its poll lands.
  saver.server = data;

  // Unmount: a typed value still inside its debounce window is saved, not lost.
  useEffect(() => () => saver.dispose(), [saver]);

  /** Server config with the user's unconfirmed edits on top. */
  const cfg = useMemo<AutopilotConfig | undefined>(() => (data ? { ...data, ...overlay } : undefined), [data, overlay]);

  const edit = useCallback((change: Overlay, mode: 'now' | 'debounced' = 'now') => saver.edit(change, mode), [saver]);

  /** Save anything pending, run one cycle on the server and take its timestamp. Rejects with the API error. */
  const runCycle = useCallback(async (): Promise<AutopilotRun> => {
    await saver.settle();
    return saver.write(async () => {
      const run = await api.runAutopilot();
      if (saver.server) saver.applyServer({ ...saver.server, last_run_at: run.ran_at });
      return run;
    });
  }, [saver]);

  return { cfg, error, loading, refreshing, reload, edit, runCycle, savedAt };
}

/** `Date.now()` that re-renders every `ms`: keeps "next run in ~n min" and "Last run 5m ago" honest. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
