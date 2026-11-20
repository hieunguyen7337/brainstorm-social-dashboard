/**
 * The one import screens use for data: typed client (`api`), types, session helpers.
 *
 *   import { api, type Post, ApiError } from '@/src/api';
 *
 * `api` routes to the real HTTP client, or to the in-memory mock when `isMock()` is true
 * (EXPO_PUBLIC_MOCK=1 builds, or the offline-demo fallback chosen on the onboarding screen).
 */
import { Linking, Platform as RNPlatform } from 'react-native';

import { getToken, isMock } from './http';
import { mockApi, mockClickLink } from './mock';
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

const current = (): PulseApi => (isMock() ? mockApi : realApi);

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
    if (post.link_code) mockClickLink(post.link_code);
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
