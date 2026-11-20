import { request } from './http';
import type { PulseApi } from './types';

/** The real HTTP client: one function per row of the REST table in docs/CONTRACT.md. */
export const realApi: PulseApi = {
  health: () => request('GET', '/api/health', { auth: false }),

  createWorkspace: (body) =>
    request('POST', '/api/workspaces', {
      auth: false,
      body: body?.brand_name?.trim() ? { brand_name: body.brand_name.trim() } : {},
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

  getAutopilot: () => request('GET', '/api/autopilot'),
  putAutopilot: (body) => request('PUT', '/api/autopilot', { body }),
  runAutopilot: () => request('POST', '/api/autopilot/run', { timeoutMs: 90000 }),

  listTrends: (q) =>
    request('GET', '/api/trends', { query: { refresh: q?.refresh ? 'true' : undefined, limit: q?.limit ?? 20 } }),
};
