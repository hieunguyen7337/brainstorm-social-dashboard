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

// ---- persisted session state ------------------------------------------------------------------

let token: string | null = null;
let mock = BUILD_MOCK;
let onUnauthorized: (() => void) | null = null;

/** Load the persisted token and mock flag once at app start. Never throws. */
export async function loadStorage(): Promise<{ token: string | null; mock: boolean }> {
  try {
    const [t, m] = await Promise.all([AsyncStorage.getItem(TOKEN_KEY), AsyncStorage.getItem(MOCK_KEY)]);
    token = t || null;
    // The offline demo is gone (every workspace is real, docs/REAL.md). A flag saved by an older version must not keep this
    // device on fake numbers: drop it. Only an EXPO_PUBLIC_MOCK=1 build (tests) runs on the in-memory fake.
    if (m !== null && !BUILD_MOCK) await AsyncStorage.removeItem(MOCK_KEY);
  } catch {
    // Storage blocked (private window, etc.): run without persistence.
  }
  return { token, mock };
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

/** True when API calls go to the in-memory fake: only an EXPO_PUBLIC_MOCK=1 build (tests, development). */
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
export function raiseUnauthorized(message = 'Your session expired. Start a new workspace.'): ApiError {
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

/**
 * One prompt to paste into Claude that sets Pulse up by itself: Claude Code runs the install and checks it; claude.ai
 * and Claude Desktop (which cannot run commands) get told exactly what to click. Uses the URL-with-token form, which
 * every client accepts.
 */
export const mcpSetupPrompt = (tok: string | null = token): string => {
  const url = mcpUrlWithToken(tok);
  return [
    'Connect my Pulse social dashboard to Claude for me. Do every step you can yourself.',
    '',
    'If you can run terminal commands (Claude Code):',
    `1. Run: claude mcp add --transport http --scope user pulse "${url}"`,
    '   If it says pulse already exists, run: claude mcp remove pulse --scope user, then add it again.',
    '2. Run: claude mcp list, and check that pulse shows as connected. If it does not, tell me the error.',
    '3. Tell me to type /mcp (or restart Claude Code) so the Pulse tools load, then ask: How is my social dashboard doing?',
    '',
    'If you cannot run commands (claude.ai or the Claude desktop app), tell me exactly what to click:',
    'Settings > Connectors > Add custom connector. Name: Pulse. URL:',
    url,
    'Then start a new chat and ask: How is my social dashboard doing?',
    '',
    'Keep that URL private: it contains my access key.',
  ].join('\n');
};

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
