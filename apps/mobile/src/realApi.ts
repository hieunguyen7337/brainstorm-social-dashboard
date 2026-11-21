import { ApiError, publicBaseUrl, request } from './http';
import type { Platform, PulseApi, RoomInfo, ShareInfo } from './types';

type Raw = Record<string, unknown>;

const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const first = (o: Raw, keys: string[]): string | null => {
  for (const k of keys) {
    const v = text(o[k]);
    if (v) return v;
  }
  return null;
};

/** The share/room APIs are still landing: accept a few spellings of each field, fail clearly on anything else. */
export function normalizeShare(raw: unknown, platform: Platform): ShareInfo {
  if (!isRaw(raw)) throw new ApiError(502, 'The server sent an unexpected share response.');
  const urls = isRaw(raw.urls) ? raw.urls : {};
  return {
    platform: (text(raw.platform) as Platform | null) ?? platform,
    url: first(raw, ['url', 'share_url', 'intent_url', 'composer_url', 'href']),
    threads_url: first(raw, ['threads_url']) ?? text(urls.threads),
    caption: first(raw, ['caption', 'text', 'content']) ?? '',
    instagram_note: first(raw, ['instagram_note', 'note']),
  };
}

export function normalizeRoom(raw: unknown): RoomInfo {
  if (!isRaw(raw)) throw new ApiError(502, 'The server sent an unexpected room response.');
  const code = first(raw, ['code', 'room_code', 'id']);
  const screen = first(raw, ['screen_url', 'screen', 'display_url']);
  const join = first(raw, ['join_url', 'join']);
  if (!code || !screen || !join) throw new ApiError(502, 'The server sent an unexpected room response.');
  const abs = (u: string) => (/^https?:/i.test(u) ? u : `${publicBaseUrl()}${u.startsWith('/') ? '' : '/'}${u}`);
  return { code, screen_url: abs(screen), join_url: abs(join), title: first(raw, ['title', 'name']) ?? '' };
}

/** The real HTTP client: one function per row of the REST table in docs/CONTRACT.md. */
export const realApi: PulseApi = {
  health: () => request('GET', '/api/health', { auth: false }),

  // Every workspace this app creates is a real one (docs/REAL.md): no seeded audience, posts or numbers. `real: false`
  // (the sample seed) is only for tests and the MCP demo, so it must be asked for explicitly.
  // The one exception is the "Try the demo" link: `demo: true` asks for the labelled synthetic workspace instead.
  createWorkspace: (body) =>
    request('POST', '/api/workspaces', {
      auth: false,
      body: {
        ...(body?.brand_name?.trim() ? { brand_name: body.brand_name.trim() } : {}),
        ...(body?.demo ? { demo: true } : { real: body?.real ?? true }),
      },
    }),
  getWorkspace: () => request('GET', '/api/workspace'),
  patchWorkspace: (body) => request('PATCH', '/api/workspace', { body }),

  listConnections: () => request('GET', '/api/connections'),
  connect: (platform, body) => request('POST', `/api/connections/${platform}`, { body }),
  disconnect: (platform) => request('DELETE', `/api/connections/${platform}`),

  getDashboard: (q) =>
    request('GET', '/api/dashboard', { query: { days: q?.days ?? 30, platform: q?.platform ?? undefined } }),
  getActivity: (limit = 30) => request('GET', '/api/activity', { query: { limit } }),
  getInsights: (q) => request('GET', '/api/insights', { query: { days: q?.days ?? 30 } }),

  listPosts: (q) =>
    request('GET', '/api/posts', {
      query: { status: q?.status ?? undefined, platform: q?.platform ?? undefined, limit: q?.limit },
    }),
  createPost: (body) => request('POST', '/api/posts', { body }),
  patchPost: (id, body) => request('PATCH', `/api/posts/${encodeURIComponent(id)}`, { body }),
  deletePost: (id) => request('DELETE', `/api/posts/${encodeURIComponent(id)}`),
  publishPost: (id) => request('POST', `/api/posts/${encodeURIComponent(id)}/publish`),
  convertLink: (code) =>
    request('POST', `/api/links/${encodeURIComponent(code)}/convert`, { auth: false }),

  listThemes: () => request('GET', '/api/themes'),
  createTheme: (body) => request('POST', '/api/themes', { body }),
  patchTheme: (id, body) => request('PATCH', `/api/themes/${encodeURIComponent(id)}`, { body }),
  deleteTheme: (id) => request('DELETE', `/api/themes/${encodeURIComponent(id)}`),

  // Claude can take a while to write six variants.
  generate: (body) => request('POST', '/api/generate', { body, timeoutMs: 90000 }),
  getAiUsage: () => request('GET', '/api/ai/usage'),

  // Claude reads the image with a vision call: allow it longer than a normal request. Nothing is saved by this call.
  readScreenshot: (platform, body) =>
    request('POST', `/api/connections/${encodeURIComponent(platform)}/screenshot`, { body, timeoutMs: 60000 }),
  // Claude reads a batch of writing samples and refines the style: allow it longer than a normal request.
  learnStyle: (body) => request('POST', '/api/workspace/style', { body, timeoutMs: 90000 }),
  forgetStyle: () => request('DELETE', '/api/workspace/style'),
  ingestMetrics: (body) => request('POST', '/api/metrics/ingest', { body }),
  getHarvestStatus: () => request('GET', '/api/connections/harvest-status'),
  demoSignIn: (platform) => request('POST', `/api/connections/${encodeURIComponent(platform)}/demo`),
  demoReadMetrics: (postId, advanceMinutes) =>
    request('POST', `/api/posts/${encodeURIComponent(postId)}/demo/metrics`, {
      query: { advance_minutes: advanceMinutes },
    }),

  getAutopilot: () => request('GET', '/api/autopilot'),
  putAutopilot: (body) => request('PUT', '/api/autopilot', { body }),
  runAutopilot: () => request('POST', '/api/autopilot/run', { timeoutMs: 90000 }),

  listTrends: (q) =>
    request('GET', '/api/trends', { query: { refresh: q?.refresh ? 'true' : undefined, limit: q?.limit ?? 20 } }),
  trendsStatus: () => request('GET', '/api/trends/status'),

  getShare: async (postId) =>
    normalizeShare(await request<unknown>('GET', `/api/posts/${encodeURIComponent(postId)}/share`), 'linkedin'),
  createRoom: async () => normalizeRoom(await request<unknown>('POST', '/api/rooms', { body: {} })),
};
