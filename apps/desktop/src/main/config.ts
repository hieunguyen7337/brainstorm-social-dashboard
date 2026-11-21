export const APP_SCHEME = 'app';
export const APP_HOST = 'pulse';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/`;

export const DEFAULT_API_URL = 'https://pulse-hackathon.fly.dev';

/** Fly API base the bundled renderer talks to (no trailing slash). */
export function apiUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.PULSE_API_URL ?? '').trim() || DEFAULT_API_URL;
  return raw.replace(/\/+$/, '');
}

export const API_URL = apiUrlFromEnv();
/** Optional override for the claude binary (used by the claude module). */
export const CLAUDE_BIN = (process.env.CLAUDE_BIN ?? '').trim() || null;
