/**
 * Per-platform sign-in flow: where the login page is, how to tell a page is past the login screens, which page(s) the
 * reader runs on, and how to turn what the reader posted into numbers. Pure data and functions (no react-native import).
 *
 * The in-page scripts live in `readers.ts`; the parsers in `parse.ts`; the state machine that drives a flow in `runner.ts`.
 */
import {
  hasNumbers,
  parseFacebookText,
  parseInstagramJson,
  parseLinkedInText,
  parseRedditJson,
  parseTikTokJson,
  parseXText,
} from './parse';
import { readerScript } from './readers';
import type { ParsedRead, Platform, StepCtx } from './types';

/** A page URL reduced to what the flows need. We never use the global `URL`: React Native's polyfill is partial. */
export interface PageUrl {
  host: string;
  path: string;
}

/** `https://user@evil.com/` style URLs, other schemes and odd hosts all give `null`. */
export function parsePageUrl(url: string | null | undefined): PageUrl | null {
  if (typeof url !== 'string') return null;
  const m = /^https?:\/\/([^/?#]*)([^?#]*)/i.exec(url.trim());
  if (!m) return null;
  const authority = m[1];
  if (authority.includes('@')) return null;
  const host = authority.replace(/:\d*$/, '').toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return { host, path: m[2] || '/' };
}

export type StepOutcome =
  /** The numbers were found: the read is complete. */
  | { kind: 'read'; read: ParsedRead; confidence: 'high' | 'medium' }
  /** This step only found something the next step needs (X: the handle). */
  | { kind: 'next'; ctx: StepCtx }
  /** Signed in, but nothing usable. `hint` may say which page is worth a screenshot. */
  | { kind: 'empty'; hint?: unknown };

export interface FlowStep {
  /** Page to open for this step. */
  url(ctx: StepCtx): string;
  /** True when the WebView is on a page this step's script may run on (checked after we opened `url`). */
  matches(url: PageUrl, ctx: StepCtx): boolean;
  /**
   * True when the page the person is already on is exactly the page to read, so no navigation is needed. Absent when
   * the page cannot be recognised by URL (Facebook `/me` redirects to the profile).
   */
  direct?(url: PageUrl, ctx: StepCtx): boolean;
  /** The reader script for this step (see `readers.ts`). */
  script(ctx: StepCtx): string;
  /** Turns the `data` of an `ok` message into an outcome. Never throws. */
  finish(data: unknown, ctx: StepCtx): StepOutcome;
  /**
   * True when this step's own page shows the person's numbers, so a screenshot of it is worth sending to Claude when the
   * reader found nothing. False when it does not (the home feed): then a screenshot is taken only of the page the flow's
   * `fallbackUrl` names, and the read gives up when there is none.
   */
  showsNumbers: boolean;
}

export interface Flow {
  platform: Platform;
  loginUrl: string;
  /** The URL is on the platform's own domain (the only place a reader may run). */
  hostOk(url: PageUrl): boolean;
  /** The URL is a login, sign-up, password-reset or challenge screen. */
  isLogin(url: PageUrl): boolean;
  /** The URL looks like a page that is only reachable once signed in (the reader still has the last word). */
  pastLogin(url: PageUrl): boolean;
  /**
   * True when "past login" is recognised by an allow-list of signed-in-only pages (LinkedIn, X): reaching one proves the
   * person is signed in. False when it only means "not a login screen" (the logged-out home page passes that test).
   */
  strongSignedIn: boolean;
  steps: FlowStep[];
  /** The page whose screenshot is worth reading when a reader found nothing; null = capture what is on screen. */
  fallbackUrl(ctx: StepCtx, hint: unknown): string | null;
}

const onDomain = (u: PageUrl, domain: string): boolean => u.host === domain || u.host.endsWith(`.${domain}`);
const startsWithAny = (path: string, prefixes: readonly string[]): boolean => {
  const p = path.toLowerCase();
  return prefixes.some((x) => p.startsWith(x));
};
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const IG_NAME = /^[A-Za-z0-9._]{1,30}$/;
const REDDIT_NAME = /^[A-Za-z0-9_-]{1,30}$/;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const read = (parsed: ParsedRead, confidence: 'high' | 'medium'): StepOutcome =>
  hasNumbers(parsed) ? { kind: 'read', read: parsed, confidence } : { kind: 'empty' };

interface FlowDef {
  platform: Platform;
  loginUrl: string;
  domains: readonly string[];
  loginPaths: readonly string[];
  /** When set, only these paths count as "past login" (platforms whose post-login landing page is recognisable). */
  signedInPaths?: readonly string[];
  steps: FlowStep[];
  fallbackUrl?: Flow['fallbackUrl'];
}

function makeFlow(def: FlowDef): Flow {
  const hostOk = (u: PageUrl) => def.domains.some((d) => onDomain(u, d));
  const isLogin = (u: PageUrl) => hostOk(u) && startsWithAny(u.path, def.loginPaths);
  return {
    platform: def.platform,
    loginUrl: def.loginUrl,
    hostOk,
    isLogin,
    pastLogin: (u) =>
      hostOk(u) && !isLogin(u) && (def.signedInPaths ? startsWithAny(u.path, def.signedInPaths) : true),
    strongSignedIn: !!def.signedInPaths,
    steps: def.steps,
    fallbackUrl: def.fallbackUrl ?? (() => null),
  };
}

// ---- Instagram -----------------------------------------------------------------------------------------------------
// Same-origin fetch works on any instagram.com page, so the reader runs wherever the person lands after signing in.

const IG_LOGIN = [
  '/accounts/login',
  '/accounts/emailsignup',
  '/accounts/signup',
  '/accounts/password',
  '/accounts/suspended',
  '/accounts/consent',
  '/challenge',
];

const instagram: Flow = (() => {
  const base = makeFlow({
    platform: 'instagram',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    domains: ['instagram.com'],
    loginPaths: IG_LOGIN,
    steps: [],
    fallbackUrl: (_ctx, hint) => {
      const name = str(rec(hint).username);
      return name && IG_NAME.test(name) ? `https://www.instagram.com/${name}/` : null;
    },
  });
  const anyPage = (u: PageUrl) => base.pastLogin(u);
  base.steps.push({
    url: () => 'https://www.instagram.com/',
    matches: anyPage,
    direct: anyPage,
    script: (ctx) => readerScript('instagram', 0, ctx),
    finish: (data) => {
      const parsed = parseInstagramJson(data);
      return hasNumbers(parsed) ? read(parsed, 'high') : { kind: 'empty', hint: { username: parsed.handle ?? null } };
    },
    showsNumbers: false, // the home feed shows no numbers; the profile page (fallbackUrl) does
  });
  return base;
})();

// ---- TikTok --------------------------------------------------------------------------------------------------------
// /profile redirects to the signed-in person's own /@user page, which carries the stats in
// #__UNIVERSAL_DATA_FOR_REHYDRATION__. Only /profile may be read "as is" (`direct`): a /@name page the person wandered
// onto may belong to someone else, so those are read only after we opened /profile ourselves (`matches`).

const tiktok: Flow = (() => {
  const isProfileRoute = (u: PageUrl) => u.path.toLowerCase().replace(/\/+$/, '') === '/profile';
  const onProfile = (u: PageUrl) => isProfileRoute(u) || /^\/@[^/]+/.test(u.path);
  return makeFlow({
    platform: 'tiktok',
    loginUrl: 'https://www.tiktok.com/login',
    domains: ['tiktok.com'],
    loginPaths: ['/login', '/signup', '/passport', '/forgot-password', '/captcha'],
    steps: [
      {
        url: () => 'https://www.tiktok.com/profile',
        matches: onProfile,
        direct: isProfileRoute,
        script: (ctx) => readerScript('tiktok', 0, ctx),
        finish: (data) => read(parseTikTokJson(data), 'high'),
        showsNumbers: true,
      },
    ],
  });
})();

// ---- LinkedIn ------------------------------------------------------------------------------------------------------
// The dashboard text has the number on the line before each label. Only the signed-in pages count as "past login":
// the logged-out landing page lives at "/".

const linkedin: Flow = (() => {
  const onDashboard = (u: PageUrl) => startsWithAny(u.path, ['/dashboard']);
  return makeFlow({
    platform: 'linkedin',
    loginUrl: 'https://www.linkedin.com/login',
    domains: ['linkedin.com'],
    loginPaths: ['/login', '/checkpoint', '/uas', '/authwall', '/signup', '/m/login', '/start/join'],
    signedInPaths: [
      '/feed',
      '/in/',
      '/mynetwork',
      '/dashboard',
      '/notifications',
      '/messaging',
      '/jobs',
      '/search',
      '/post/',
      '/analytics',
    ],
    steps: [
      {
        url: () => 'https://www.linkedin.com/dashboard/',
        matches: onDashboard,
        direct: onDashboard,
        script: (ctx) => readerScript('linkedin', 0, ctx),
        finish: (data) => read(parseLinkedInText(str(rec(data).text) ?? ''), 'medium'),
        showsNumbers: true,
      },
    ],
  });
})();

// ---- X -------------------------------------------------------------------------------------------------------------
// Step 0 reads the signed-in handle on /home; step 1 opens x.com/<handle> and reads "<n> Followers" / "<n> Following".

const x: Flow = (() => {
  const onHome = (u: PageUrl) => startsWithAny(u.path, ['/home']);
  const onProfile = (u: PageUrl, ctx: StepCtx) =>
    !!ctx.handle && u.path.toLowerCase().replace(/\/+$/, '') === `/${ctx.handle.toLowerCase()}`;
  return makeFlow({
    platform: 'x',
    loginUrl: 'https://x.com/i/flow/login',
    domains: ['x.com', 'twitter.com'],
    loginPaths: ['/i/flow', '/login', '/logout', '/account/access'],
    signedInPaths: ['/home'],
    steps: [
      {
        url: () => 'https://x.com/home',
        matches: onHome,
        direct: onHome,
        script: (ctx) => readerScript('x', 0, ctx),
        finish: (data) => {
          const handle = str(rec(data).handle)?.replace(/^@/, '') ?? null;
          return handle && X_HANDLE.test(handle) ? { kind: 'next', ctx: { handle } } : { kind: 'empty' };
        },
        showsNumbers: false,
      },
      {
        url: (ctx) => `https://x.com/${ctx.handle ?? ''}`,
        matches: onProfile,
        script: (ctx) => readerScript('x', 1, ctx),
        finish: (data, ctx) => {
          const d = rec(data);
          return read(parseXText(str(d.text) ?? '', str(d.handle) ?? ctx.handle ?? null), 'medium');
        },
        showsNumbers: true,
      },
    ],
    fallbackUrl: (ctx) => (ctx.handle && X_HANDLE.test(ctx.handle) ? `https://x.com/${ctx.handle}` : null),
  });
})();

// ---- Reddit --------------------------------------------------------------------------------------------------------
// Same-origin fetch of /api/me.json (and the user's about.json) works on any reddit.com page.

const reddit: Flow = (() => {
  const base = makeFlow({
    platform: 'reddit',
    loginUrl: 'https://www.reddit.com/login/',
    domains: ['reddit.com'],
    loginPaths: ['/login', '/register', '/account', '/password', '/verification'],
    steps: [],
    fallbackUrl: (_ctx, hint) => {
      const name = str(rec(hint).name);
      return name && REDDIT_NAME.test(name) ? `https://www.reddit.com/user/${name}/` : null;
    },
  });
  const anyPage = (u: PageUrl) => base.pastLogin(u);
  base.steps.push({
    url: () => 'https://www.reddit.com/',
    matches: anyPage,
    direct: anyPage,
    script: (ctx) => readerScript('reddit', 0, ctx),
    finish: (data) => {
      const d = rec(data);
      const parsed = parseRedditJson(d.me, d.about);
      return hasNumbers(parsed) ? read(parsed, 'high') : { kind: 'empty', hint: { name: parsed.handle ?? null } };
    },
    showsNumbers: false, // reddit.com shows no numbers; the user's profile page (fallbackUrl) does
  });
  return base;
})();

// ---- Facebook ------------------------------------------------------------------------------------------------------
// /me redirects to the profile, so the landing page cannot be recognised by URL: always navigate, then accept any page
// that is not a login screen.

const facebook: Flow = (() => {
  const base = makeFlow({
    platform: 'facebook',
    loginUrl: 'https://m.facebook.com/login/',
    domains: ['facebook.com'],
    loginPaths: ['/login', '/checkpoint', '/recover', '/two_step_verification', '/device-based', '/r.php', '/reg'],
    steps: [],
  });
  base.steps.push({
    url: () => 'https://m.facebook.com/me',
    matches: (u) => base.pastLogin(u),
    script: (ctx) => readerScript('facebook', 0, ctx),
    finish: (data) => read(parseFacebookText(str(rec(data).text) ?? ''), 'medium'),
    showsNumbers: true,
  });
  return base;
})();

const FLOWS: Record<Platform, Flow> = { instagram, tiktok, linkedin, x, reddit, facebook };

export function flowFor(platform: Platform): Flow {
  return FLOWS[platform];
}
