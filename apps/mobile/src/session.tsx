/**
 * Session: the guest workspace token + workspace profile, plus the boot / start / reset flows.
 * A 401 from any call clears the token (see `http.raiseUnauthorized`) and lands here via the handler, which flips
 * the status to 'anon' so the layouts redirect to onboarding.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  api,
  ApiError,
  getToken,
  isMock,
  loadStorage,
  setMockMode,
  setToken,
  setUnauthorizedHandler,
  type Workspace,
} from './api';
import { clearRoomWelcome, markRoomJoined, ROOM_GUEST_BRAND } from './components/room/roomStore';

export type SessionStatus =
  /** Reading storage / validating the saved token. */
  | 'loading'
  /** No (valid) token: show onboarding. */
  | 'anon'
  /** Token is valid, workspace loaded. */
  | 'ready'
  /** A token exists but the server cannot be reached. */
  | 'offline';

export interface Session {
  status: SessionStatus;
  workspace: Workspace | null;
  token: string | null;
  /** Running against the in-memory fake (mock build or the offline-demo fallback). */
  mock: boolean;
  /** Last start/boot failure message for onboarding / the offline screen. */
  error: string | null;
  /** The last failure was "cannot reach the server" (offer the offline demo). */
  networkError: boolean;
  /** `POST /api/workspaces` in flight. */
  starting: boolean;
  /** Create a fresh guest workspace (optional brand name) and enter the app. Resolves true on success. */
  start: (brandName?: string) => Promise<boolean>;
  /** Same, but against the in-memory fake (used when the server is unreachable). */
  startOfflineDemo: (brandName?: string) => Promise<boolean>;
  /**
   * Room link (`/?room=CODE`): remember the room and, when there is no session yet, create the guest workspace with no
   * form. An existing session is never replaced. Resolves true when a workspace is (or already was) ready.
   */
  joinRoom: (code: string) => Promise<boolean>;
  /** Re-validate the saved token (offline screen "Try again"). */
  retry: () => Promise<void>;
  /** Forget this workspace on this device and return to onboarding. */
  signOut: () => Promise<void>;
  /** Replace the cached workspace after an edit (Settings). */
  setWorkspace: (ws: Workspace) => void;
}

const Ctx = createContext<Session | null>(null);

function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [workspace, setWorkspaceState] = useState<Workspace | null>(null);
  const [token, setTokenState] = useState<string | null>(null);
  const [mock, setMock] = useState(isMock());
  const [error, setError] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState(false);
  const [starting, setStarting] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setUnauthorizedHandler(() => {
      if (!alive.current) return;
      setWorkspaceState(null);
      setTokenState(null);
      setStatus('anon');
    });
    return () => {
      alive.current = false;
      setUnauthorizedHandler(null);
    };
  }, []);

  const boot = useCallback(async () => {
    setStatus('loading');
    setError(null);
    setNetworkError(false);
    const stored = await loadStorage();
    setMock(stored.mock);
    if (!stored.token) {
      setStatus('anon');
      return;
    }
    setTokenState(stored.token);
    try {
      const ws = await api.getWorkspace();
      if (!alive.current) return;
      setWorkspaceState(ws);
      setStatus('ready');
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status === 401) return; // handler already moved us to 'anon'
      setError(messageOf(e));
      const net = e instanceof ApiError && e.isNetwork;
      setNetworkError(net);
      setStatus(net ? 'offline' : 'anon');
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const start = useCallback(async (brandName?: string) => {
    setStarting(true);
    setError(null);
    setNetworkError(false);
    try {
      const { token: tok, ...ws } = await api.createWorkspace({ brand_name: brandName?.trim() || null });
      await setToken(tok);
      if (!alive.current) return true;
      setTokenState(tok);
      setWorkspaceState(ws);
      setMock(isMock());
      setStatus('ready');
      return true;
    } catch (e) {
      if (alive.current) {
        setError(messageOf(e));
        setNetworkError(e instanceof ApiError && e.isNetwork);
      }
      return false;
    } finally {
      if (alive.current) setStarting(false);
    }
  }, []);

  const startOfflineDemo = useCallback(
    async (brandName?: string) => {
      await setMockMode(true);
      setMock(true);
      return start(brandName);
    },
    [start],
  );

  const joinRoom = useCallback(
    async (code: string) => {
      // A session exists: keep it (never clobber a workspace), just remember the room and queue the welcome once.
      if (getToken()) {
        void markRoomJoined(code);
        return true;
      }
      // Pending flag first (synchronous in memory): the Dashboard shows the welcome the moment it mounts.
      void markRoomJoined(code, true);
      // A leftover offline-demo flag (its in-memory data died with the last page load) must not hijack the room join:
      // try the real server first; if it is unreachable, onboarding offers the offline demo again.
      if (isMock()) {
        await setMockMode(false);
        if (alive.current) setMock(isMock());
      }
      return start(ROOM_GUEST_BRAND);
    },
    [start],
  );

  const signOut = useCallback(async () => {
    clearRoomWelcome();
    await setToken(null);
    await setMockMode(false);
    if (!alive.current) return;
    setMock(isMock());
    setWorkspaceState(null);
    setTokenState(null);
    setError(null);
    setNetworkError(false);
    setStatus('anon');
  }, []);

  const value = useMemo<Session>(
    () => ({
      status,
      workspace,
      token,
      mock,
      error,
      networkError,
      starting,
      start,
      startOfflineDemo,
      joinRoom,
      retry: boot,
      signOut,
      setWorkspace: setWorkspaceState,
    }),
    [status, workspace, token, mock, error, networkError, starting, start, startOfflineDemo, joinRoom, boot, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
