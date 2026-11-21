/**
 * Test harness: runs a reader script for real, in a node `vm` context whose `document` / `location` are a jsdom page, with a
 * fake `fetch`, a fake bridge and a virtual clock (timers and `Date.now`), so a 10 s reader deadline takes milliseconds.
 */
import { JSDOM } from 'jsdom';
import vm from 'vm';

export interface FakeResponse {
  status: number;
  body?: unknown; // JSON-serialised unless a string
  /** never settles (a hung request) */
  hang?: boolean;
}
export type FetchHandler = FakeResponse | ((url: string, init: any) => FakeResponse);

export interface FetchCall {
  url: string;
  init: any;
}

export interface Env {
  posted: any[];
  rawPosted: string[];
  calls: FetchCall[];
  dom: JSDOM;
  now(): number;
  /** Schedule test code on the virtual clock (e.g. the nav bar appearing). */
  at(ms: number, fn: () => void): void;
  /** Move the virtual clock forward, running due timers and flushing promises on the way. */
  advance(ms: number): Promise<void>;
  inject(script: string): void;
}

const flush = () => new Promise<void>((r) => setImmediate(r));

export interface EnvOptions {
  html?: string;
  url?: string;
  cookies?: string[];
  /** url substring -> response; first match wins. Unmatched urls answer 404. */
  routes?: Array<[string, FetchHandler]>;
  noBridge?: boolean;
}

export function makeEnv(opts: EnvOptions = {}): Env {
  const dom = new JSDOM(opts.html ?? '<!doctype html><html><body></body></html>', {
    url: opts.url ?? 'https://www.instagram.com/',
  });
  for (const c of opts.cookies ?? []) dom.window.document.cookie = c;

  let nowMs = 1_000_000;
  let seq = 0;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const setT = (fn: () => void, ms?: number) => {
    const id = ++seq;
    timers.push({ id, at: nowMs + Math.max(0, Number(ms) || 0), fn });
    return id;
  };
  const clearT = (id: number) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };

  const posted: any[] = [];
  const rawPosted: string[] = [];
  const calls: FetchCall[] = [];

  const fakeFetch = (url: string, init: any) => {
    calls.push({ url, init });
    const hit = (opts.routes ?? []).find(([frag]) => url.includes(frag));
    const h = hit ? hit[1] : { status: 404 };
    const r = typeof h === 'function' ? h(url, init) : h;
    if (r.hang) return new Promise(() => {});
    const text = typeof r.body === 'string' ? r.body : r.body === undefined ? '' : JSON.stringify(r.body);
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: () => Promise.resolve(text) });
  };

  const win: any = {};
  if (!opts.noBridge) {
    win.ReactNativeWebView = {
      postMessage: (s: string) => {
        rawPosted.push(s);
        posted.push(JSON.parse(s));
      },
    };
  }
  const ctx = vm.createContext({
    window: win,
    document: dom.window.document,
    location: dom.window.location,
    fetch: fakeFetch,
    setTimeout: setT,
    clearTimeout: clearT,
    Date: { now: () => nowMs },
    AbortController,
  });

  return {
    posted,
    rawPosted,
    calls,
    dom,
    now: () => nowMs,
    at: (ms, fn) => void setT(fn, ms),
    inject: (script) => void vm.runInContext(script, ctx),
    async advance(ms) {
      const target = nowMs + ms;
      await flush();
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        nowMs = Math.max(nowMs, next.at);
        next.fn();
        await flush();
      }
      nowMs = target;
      await flush();
    },
  };
}

// ---- DOM fixtures ---------------------------------------------------------------------------------------------------

/** Instagram's mobile bottom bar: each link in its own wrapper div, like the real markup. */
export const navBar = (user: string, extra = ''): string =>
  `<div id="bar"><div><a href="/">Home</a></div><div><a href="/explore/">Explore</a></div>` +
  `<div><a href="/reels/">Reels</a></div><div><a href="/direct/inbox/">Messages</a></div>${extra}` +
  `<div><a href="/${user}/"><img alt="profile"></a></div></div>`;

/** Story avatars: links to other people, OUTSIDE the bar. */
export const stories = `<section id="stories"><a href="/story_alice/">a</a><a href="/story.bob/">b</a><a href="/zed_last_story/">z</a></section>`;

export const page = (inner: string): string => `<!doctype html><html><body>${inner}</body></html>`;

export const profileJson = (username: string, followers = 1234, following = 56, posts = 78) => ({
  data: {
    user: {
      username,
      edge_followed_by: { count: followers },
      edge_follow: { count: following },
      edge_owner_to_timeline_media: {
        count: posts,
        edges: [
          {
            node: {
              taken_at_timestamp: 1_700_000_000,
              is_video: false,
              edge_liked_by: { count: 9 },
              edge_media_to_comment: { count: 2 },
              edge_media_to_caption: { edges: [{ node: { text: 'hello' } }] },
            },
          },
        ],
      },
    },
  },
});
