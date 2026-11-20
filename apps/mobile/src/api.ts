/**
 * The one import screens use for data: typed client (`api`), types, session helpers.
 *
 *   import { api, type Post, ApiError } from '@/src/api';
 *
 * `api` routes to the real HTTP client, or to the in-memory mock when `isMock()` is true
 * (EXPO_PUBLIC_MOCK=1 builds only: tests and development. No screen in the app offers the mock as a demo).
 */
import { Linking, Platform as RNPlatform } from 'react-native';

import { getToken, isMock } from './http';
import { realApi } from './realApi';
import type { Post, PulseApi } from './types';

export * from './types';
export {
  ApiError,
  androidDownloadUrl,
  apiBase,
  getToken,
  isMock,
  loadStorage,
  mcpCommand,
  mcpUrl,
  mcpUrlWithToken,
  publicBaseUrl,
  setMockMode,
  setToken,
  setUnauthorizedHandler,
} from './http';

/**
 * The in-memory mock (53 KB) is only needed for mock builds, so it is loaded on first use instead of sitting in the
 * first-load chunk of real web builds. Every PulseApi method already returns a Promise.
 */
const loadMock = () => import('./mock');
const lazyMockApi: PulseApi = new Proxy({} as PulseApi, {
  get:
    (_target, prop: string) =>
    (...args: unknown[]) =>
      loadMock().then((m) => (m.mockApi as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args)),
});

const current = (): PulseApi => (isMock() ? lazyMockApi : realApi);

/** Delegates every call to whichever implementation is active right now. */
export const api: PulseApi = new Proxy({} as PulseApi, {
  get(_target, prop: string) {
    const impl = current();
    const member = (impl as unknown as Record<string, unknown>)[prop];
    return typeof member === 'function' ? member.bind(impl) : member;
  },
});

/**
 * Open a post's tracked link the way a real visitor would: the browser hits `/r/<code>`, the API records
 * the click and redirects to the landing page. In mock mode there is no server, so record the click locally.
 */
export async function openTrackedLink(post: Pick<Post, 'link_url' | 'link_code'>): Promise<void> {
  if (!post.link_url) return;
  if (isMock()) {
    if (post.link_code) {
      const code = post.link_code;
      void loadMock().then((m) => m.mockClickLink(code));
    }
    return;
  }
  if (RNPlatform.OS === 'web' && typeof window !== 'undefined') {
    window.open(post.link_url, '_blank', 'noopener');
    return;
  }
  await Linking.openURL(post.link_url);
}

/** Token for display in the MCP card. */
export const currentToken = (): string | null => getToken();
