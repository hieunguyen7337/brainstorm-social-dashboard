/**
 * Sign-in diagnostics sent to the server log (POST /api/autoread/trace), so a tester's failed read can be seen without a
 * cable. Events carry phases, page hosts and paths (no query string), injection counts and the reader's status codes.
 * Never page text, cookies, form values or tokens. Best effort: a failed send is dropped.
 */
import { Platform } from 'react-native';

import { request } from '@/src/http';

const FLUSH_MS = 4_000;
const MAX_EVENTS = 400;

export interface Tracer {
  trace(event: string, detail?: Record<string, unknown>): void;
  stop(): void;
}

function appInfo(): Record<string, unknown> {
  const info: Record<string, unknown> = { os: Platform.OS, osv: Platform.Version };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const U = require('expo-updates');
    info.update = U.updateId ?? null;
    info.embedded = U.isEmbeddedLaunch ?? null;
    info.created = U.createdAt ? String(U.createdAt) : null;
    info.channel = U.channel ?? null;
  } catch {
    // not available (web, tests)
  }
  return info;
}

export function makeTracer(platform: string): Tracer {
  const run = Math.random().toString(36).slice(2, 10);
  const t0 = Date.now();
  const app = appInfo();
  let buf: Record<string, unknown>[] = [];
  let count = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const flush = () => {
    if (!buf.length) return;
    const events = buf;
    buf = [];
    request('POST', '/api/autoread/trace', { body: { platform, run, app, events }, timeoutMs: 10_000 }).catch(() => {});
  };
  return {
    trace(event, detail) {
      if (count >= MAX_EVENTS) return;
      count += 1;
      buf.push({ ms: Date.now() - t0, e: event, ...(detail ?? {}) });
      if (!timer) timer = setInterval(flush, FLUSH_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      flush();
    },
  };
}
