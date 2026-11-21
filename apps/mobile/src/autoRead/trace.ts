/**
 * Sign-in diagnostics sent to the server log (POST /api/autoread/trace), so a tester's failed read can be seen without a
 * cable. Events carry phases, page hosts and paths (no query string), injection counts and the reader's status codes.
 * Never page text, cookies, form values or tokens: `scrub` enforces that on every event before it is queued, whatever the
 * caller or the page passed in (a reader's `diag` comes from the page). The server redacts again
 * (apps/api/app/routes/autoread_trace.py): keep the two in step. Best effort: a failed send is dropped.
 */
import { Platform } from 'react-native';

import { request } from '@/src/http';

const FLUSH_MS = 4_000;
const MAX_EVENTS = 400;
/** Serialized size of one event after `scrub`; 400 of them stay under the server's 256 KiB body cap. */
const MAX_EVENT_CHARS = 512;
const MAX_STR = 120;
const MAX_ITEMS = 24;
const MAX_DEPTH = 3;
const REDACTED = '[redacted]';

// Free-form text is kept only under these keys (the ones the trace uses); a string under any other key is dropped,
// because a typed value cannot be told from a diagnostic by its shape.
const STRING_KEYS = new Set(['e', 'host', 'path', 'status', 'phase', 'from', 'p', 'src', 'os', 'osv', 'update', 'channel', 'created', 'via']);
// A field named like a secret keeps only a yes/no (the readers send `csrf: true`, never the value).
const SECRET_KEY = /pass|pwd|secret|token|cookie|csrf|xsrf|sess|auth|bearer|otp|code|credential|key|html|body|text|value|input|query|search/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER = /\bbearer\s+\S+/gi;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g;
const ASSIGN = /\b(\w*(?:pass|pwd|secret|token|cookie|csrf|sess|auth|otp|code|key)\w*)\s*[=:]\s*\S+/gi;
const URL_QUERY = /(https?:\/\/[^\s?#]+)[?#]\S*/gi;
const RUN = /[A-Za-z0-9_\-+=]{24,}/g;

/** A path segment that looks like an id, reset token or challenge code rather than a word. */
function opaqueSegment(seg: string): boolean {
  if (/^\d{5,}$/.test(seg)) return true;
  if (!/^[A-Za-z0-9_\-+=%]+$/.test(seg)) return false;
  return seg.length >= 20 || (seg.length >= 12 && /\d/.test(seg) && /[A-Za-z]/.test(seg));
}

function cleanString(input: string): string {
  if (UUID.test(input)) return input;
  let s = input;
  if (/^(https?:\/\/|\/)/i.test(s)) {
    s = s.split(/[?#]/, 1)[0];
    s = s.split('/').map((p) => (opaqueSegment(p) ? ':id' : p)).join('/');
  }
  s = s.replace(URL_QUERY, '$1').replace(BEARER, `Bearer ${REDACTED}`).replace(JWT, REDACTED);
  s = s.replace(ASSIGN, (_m, name: string) => `${name}=${REDACTED}`).replace(RUN, REDACTED);
  if (/^\d{4,10}$/.test(s)) s = REDACTED;
  return s.length <= MAX_STR ? s : `${s.slice(0, MAX_STR)}…`;
}

/** A copy of `value` with secrets redacted and every size bounded (see the file header). */
export function scrub(value: unknown, key = '', depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return STRING_KEYS.has(key) ? cleanString(value) : REDACTED;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => scrub(v, key, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      if (v !== undefined) out[cleanString(k).slice(0, 40)] = scrub(v, k, depth + 1);
    }
    return out;
  }
  return null;
}

function scrubEvent(event: Record<string, unknown>): Record<string, unknown> {
  const clean = scrub(event, '', -1) as Record<string, unknown>;
  if (JSON.stringify(clean).length <= MAX_EVENT_CHARS) return clean;
  return { ms: typeof clean.ms === 'number' ? clean.ms : null, e: String(clean.e ?? '').slice(0, 40), truncated: true };
}

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
  const app = scrub(appInfo()) as Record<string, unknown>;
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
      buf.push(scrubEvent({ ms: Date.now() - t0, e: event, ...(detail ?? {}) }));
      if (!timer) timer = setInterval(flush, FLUSH_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      flush();
    },
  };
}
