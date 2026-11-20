/**
 * Transport layer: base URL, bearer-token persistence, 401 handling, mock-mode flag, fetch wrapper.
 * No imports from the mock or the typed client, so both can depend on it without cycles.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform as RNPlatform } from 'react-native';

const TOKEN_KEY = 'pulse.token';
const MOCK_KEY = 'pulse.mock';

// Metro inlines `process.env.EXPO_PUBLIC_*` only for literal member access, so keep these spelled out.
const ENV_API_URL = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
const BUILD_MOCK = process.env.EXPO_PUBLIC_MOCK === '1';
/** Placeholder until the lead confirms the Fly hostname (matches eas.json). */
const FALLBACK_PUBLIC_URL = 'https://pulse-hackathon.fly.dev';

export class ApiError extends Error {
  /** HTTP status, or 0 when the server could not be reached. */
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

// ---- team workspace link --------------------------------------------------------------------

/**
 * Web only: `https://<host>/?token=<t>` opens that existing (team) workspace instead of a fresh guest one.
 * Read once at module load, before the router can touch the URL, then removed from the address bar so the token
 * does not linger in history, screenshots or referrers (it is persisted like any other session token).
 */
function readUrlToken(): string | null {
  if (RNPlatform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get('token');
    if (raw === null) return null;
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    const clean = raw.trim();
    return /^[A-Za-z0-9._~-]{1,200}$/.test(clean) ? clean : null;
  } catch {
    return null;
  }
}
const URL_TOKEN = readUrlToken();

// ---- persisted session state ------------------------------------------------------------------

let token: string | null = null;
let mock = BUILD_MOCK;
let onUnauthorized: (() => void) | null = null;

/**
 * Load the persisted token and mock flag once at app start. A `?token=` in the URL (web) wins over the stored one
 * and is persisted. Never throws.
 */
export async function loadStorage(): Promise<{ token: string | null; mock: boolean; fromUrl: boolean }> {
  try {
    const [t, m] = await Promise.all([AsyncStorage.getItem(TOKEN_KEY), AsyncStorage.getItem(MOCK_KEY)]);
    token = t || null;
    if (!BUILD_MOCK) mock = m === '1';
  } catch {
    // Storage blocked (private window, etc.): run without persistence.
  }
  const fromUrl = URL_TOKEN !== null && !BUILD_MOCK;
  if (fromUrl) {
    // A team link points at the real server, never at the offline demo.
    token = URL_TOKEN;
    mock = false;
    try {
      await Promise.all([AsyncStorage.setItem(TOKEN_KEY, URL_TOKEN as string), AsyncStorage.removeItem(MOCK_KEY)]);
    } catch {
      // ignore
    }
  }
  return { token, mock, fromUrl };
}

export function getToken(): string | null {
  return token;
}

export async function setToken(next: string | null): Promise<void> {
  token = next;
  try {
    if (next) await AsyncStorage.setItem(TOKEN_KEY, next);
    else await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

/** True when API calls go to the in-memory fake (EXPO_PUBLIC_MOCK=1 build, or the offline-demo fallback). */
export function isMock(): boolean {
  return mock;
}

export async function setMockMode(on: boolean): Promise<void> {
  if (BUILD_MOCK) return; // a mock build is always mock
  mock = on;
  try {
    if (on) await AsyncStorage.setItem(MOCK_KEY, '1');
    else await AsyncStorage.removeItem(MOCK_KEY);
  } catch {
    // ignore
  }
}

/** The session provider registers this: it flips the app back to onboarding after a 401. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/** Clear the token, send the user back to onboarding, and return the error to throw. */
export function raiseUnauthorized(message = 'Your session expired. Start a new demo.'): ApiError {
  void setToken(null);
  onUnauthorized?.();
  return new ApiError(401, message);
}

// ---- URLs -------------------------------------------------------------------------------------

/** Base for API requests: same origin on web (the API serves the export), EXPO_PUBLIC_API_URL elsewhere. */
export function apiBase(): string {
  if (RNPlatform.OS === 'web') {
    // `expo start --web` serves from Metro, so allow an explicit override in dev only.
    return __DEV__ && ENV_API_URL ? ENV_API_URL : '';
  }
  return ENV_API_URL || FALLBACK_PUBLIC_URL;
}

/** Absolute origin of the backend, for showing links to the user (MCP url, APK download). */
export function publicBaseUrl(): string {
  const base = apiBase();
  if (base) return base;
  if (RNPlatform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return FALLBACK_PUBLIC_URL;
}

export const mcpUrl = (): string => `${publicBaseUrl()}/mcp`;

/** The line judges paste into a terminal to connect Claude Code to their workspace. */
export const mcpCommand = (tok: string | null = token): string =>
  `claude mcp add --transport http pulse ${mcpUrl()} --header "Authorization: Bearer ${tok ?? '<token>'}"`;

/** URL form for clients that cannot send headers (claude.ai custom connector): MCP accepts `?token=`. */
export const mcpUrlWithToken = (tok: string | null = token): string =>
  `${mcpUrl()}?token=${tok ?? '<token>'}`;

export const androidDownloadUrl = (): string => `${publicBaseUrl()}/download/android`;

// ---- fetch wrapper ----------------------------------------------------------------------------

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** Send the bearer token and treat a 401 as "session lost". Default true. */
  auth?: boolean;
  timeoutMs?: number;
}

function queryString(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** FastAPI errors are `{detail: "..."}` or, for 422, `{detail: [{loc, msg}]}`. */
async function errorDetail(res: Response): Promise<string | null> {
  try {
    const data = await res.json();
    const d = data?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) {
      return d
        .map((e: { loc?: unknown[]; msg?: string }) => {
          const field = Array.isArray(e.loc) ? String(e.loc[e.loc.length - 1]) : '';
          return field && field !== 'body' ? `${field}: ${e.msg ?? 'invalid'}` : (e.msg ?? 'invalid');
        })
        .join('; ');
    }
  } catch {
    // not JSON
  }
  return null;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const { body, query, auth = true, timeoutMs = 20000 } = opts;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(apiBase() + path + queryString(query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(0, ctrl.signal.aborted ? 'The server took too long to answer.' : 'Cannot reach the server.');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 && auth) throw raiseUnauthorized((await errorDetail(res)) ?? undefined);
  if (!res.ok) throw new ApiError(res.status, (await errorDetail(res)) ?? `Request failed (${res.status})`);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(res.status, 'The server sent an unreadable response.');
  }
}
