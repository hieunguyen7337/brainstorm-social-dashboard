/**
 * Session: the guest workspace token + workspace profile, plus the boot / start / reset flows.
 * A 401 from any call clears the token (see `http.raiseUnauthorized`) and lands here via the handler, which flips
 * the status to 'anon' so the layouts redirect to onboarding.
 *
 * Every workspace this app creates is a real one (`real: true`, docs/REAL.md): no seeded audience, posts or numbers.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import {
  api,
  ApiError,
  getToken,
  isMock,
  loadStorage,
  PLATFORMS,
  setToken,
  setUnauthorizedHandler,
  type Platform as PulsePlatform,
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
  /** Running against the in-memory fake: only an EXPO_PUBLIC_MOCK=1 build (tests, development). */
  mock: boolean;
  /** Last start/boot failure message for onboarding / the offline screen. */
  error: string | null;
  /** The last failure was "cannot reach the server". */
  networkError: boolean;
  /** `POST /api/workspaces` in flight. */
  starting: boolean;
  /** Create a fresh real guest workspace (optional brand name) and enter the app. Resolves true on success. */
  start: (brandName?: string) => Promise<boolean>;
  /**
   * Web link `/#ws=<token>&connect=<platform>` (what a phone without the image picker opens in its browser): the platform
   * whose connect sheet should open once the workspace is ready. `clearConnectRequest` after opening it.
   */
  connectRequest: PulsePlatform | null;
  clearConnectRequest: () => void;
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

/**
 * Web: `/#ws=<token>` opens that workspace in this browser, so a workspace made elsewhere (a script, another device)
 * can be opened with one link; `&connect=<platform>` also opens that platform's connect sheet (the app without the image
 * picker sends people here to upload a screenshot). The token sits in the hash, which browsers never send to the server,
 * and the hash is removed from the address bar at once.
 */
function takeWorkspaceLink(): { token: string | null; connect: PulsePlatform | null } {
  const none = { token: null, connect: null };
  if (Platform.OS !== 'web' || typeof window === 'undefined') return none;
  const hash = window.location.hash;
  const ws = /(?:^#|&)ws=([A-Za-z0-9_-]{20,64})(?:&|$)/.exec(hash);
  const connect = /(?:^#|&)connect=([a-z]{1,16})(?:&|$)/.exec(hash);
  if (!ws && !connect) return none;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  const platform = connect && (PLATFORMS as readonly string[]).includes(connect[1]) ? (connect[1] as PulsePlatform) : null;
  return { token: ws ? ws[1] : null, connect: platform };
}

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
  const [connectRequest, setConnectRequest] = useState<PulsePlatform | null>(null);
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
    let stored = await loadStorage();
    const link = takeWorkspaceLink();
    const linked = link.token;
    if (linked && linked !== stored.token && !stored.mock) {
      await setToken(linked);
      stored = { ...stored, token: linked };
    }
    setMock(stored.mock);
    if (!stored.token) {
      setStatus('anon');
      return;
    }
    setTokenState(stored.token);
    try {
      const ws = await api.getWorkspace();
      if (!alive.current) return;
      // Real numbers for everyone: a sample workspace saved by an older version (made-up numbers) is forgotten, so its
      // visitor lands on onboarding and starts a real one. Mock builds keep theirs.
      if (ws.data_mode === 'sample' && !stored.mock) {
        await setToken(null);
        if (!alive.current) return;
        setTokenState(null);
        setStatus('anon');
        return;
      }
      setWorkspaceState(ws);
      // Only a valid workspace opens the connect sheet (an unknown token lands on onboarding instead).
      setConnectRequest(link.connect);
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
      const { token: tok, ...ws } = await api.createWorkspace({ brand_name: brandName?.trim() || null, real: true });
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

  const clearConnectRequest = useCallback(() => setConnectRequest(null), []);

  // A brand edit hands back the whole workspace. Should a response ever omit the data mode, keep the one we had: a real
  // workspace must never turn into a sample one (and show fake numbers) because of an edit.
  const setWorkspace = useCallback((ws: Workspace) => {
    setWorkspaceState((prev) => ({ ...ws, data_mode: ws.data_mode ?? prev?.data_mode }));
  }, []);

  const joinRoom = useCallback(
    async (code: string) => {
      // A session exists: keep it (never clobber a workspace), just remember the room and queue the welcome once.
      if (getToken()) {
        void markRoomJoined(code);
        return true;
      }
      // Pending flag first (synchronous in memory): the Dashboard shows the welcome the moment it mounts.
      void markRoomJoined(code, true);
      return start(ROOM_GUEST_BRAND);
    },
    [start],
  );

  const signOut = useCallback(async () => {
    clearRoomWelcome();
    await setToken(null);
    if (!alive.current) return;
    setMock(isMock());
    setWorkspaceState(null);
    setTokenState(null);
    setConnectRequest(null);
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
      connectRequest,
      clearConnectRequest,
      joinRoom,
      retry: boot,
      signOut,
      setWorkspace,
    }),
    [
      status,
      workspace,
      token,
      mock,
      error,
      networkError,
      starting,
      start,
      connectRequest,
      clearConnectRequest,
      joinRoom,
      boot,
      signOut,
      setWorkspace,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/** True in a real workspace (docs/REAL.md): every number on screen comes from the person. Old guest workspaces are 'sample'. */
export const isRealWorkspace = (ws: Workspace | null | undefined): boolean => ws?.data_mode === 'real';

export function useIsRealWorkspace(): boolean {
  return isRealWorkspace(useSession().workspace);
}
