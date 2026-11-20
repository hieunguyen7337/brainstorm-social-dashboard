import { ApiError, endpointAvailable, request } from './http';
import { normalizeHarvestStatus, normalizeInsights } from './normalize';
import type { PulseApi } from './types';

/**
 * Optional features (insights, harvest, billing): `null` when this server does not have the endpoint, so the UI can
 * hide itself. The OpenAPI document is consulted first, so a missing endpoint never produces a 404 in the console.
 */
async function optional<T>(template: string, call: () => Promise<T>): Promise<T | null> {
  if (!(await endpointAvailable(template))) return null;
  try {
    return await call();
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)) return null;
    throw e;
  }
}

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

  getInsights: (days = 30) =>
    optional('/api/insights', async () => normalizeInsights(await request('GET', '/api/insights', { query: { days } }), days)),
  refreshInsights: () =>
    optional('/api/insights/refresh', async () =>
      normalizeInsights(await request('POST', '/api/insights/refresh', { timeoutMs: 60000 })),
    ),

  setConnectionProfile: (platform, profileUrl) =>
    request('PUT', `/api/connections/${platform}/profile`, { body: { profile_url: profileUrl } }),
  getHarvestStatus: () =>
    optional('/api/connections/harvest-status', async () =>
      normalizeHarvestStatus(await request('GET', '/api/connections/harvest-status')),
    ),

  getBilling: () => optional('/api/billing', () => request('GET', '/api/billing')),
  createCheckout: (body) => request('POST', '/api/billing/checkout', { body: body ?? {} }),
  createPortal: () => request('POST', '/api/billing/portal'),
};
