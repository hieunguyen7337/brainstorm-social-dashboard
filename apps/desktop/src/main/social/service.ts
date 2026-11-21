/**
 * The social service: what the IPC handlers (and the Instagram poster, unit D4) call. Pure apart from injected deps.
 *
 * Stable API for D4:
 *   const social = getSocial();
 *   await social.status();                       // { instagram: { signedIn, lastReadAt }, ... }
 *   await social.read('instagram');              // hidden read, never shows a window
 *   await social.connect('instagram');           // interactive: may show the login window
 *   await social.runTask('instagram', { url, visible }, async (wc) => { ... });
 *   const off = social.onPageMessage(wc, (raw) => ...);   // reader/poster messages from that window's shim
 *
 * `read()` results: `{ ok: true, read }`, or `{ ok: false, reason }` with `reason === SIGNED_OUT` ('signed_out': no
 * session, or the platform sent the hidden window to a login page; no window was shown), or a human message
 * (the autoRead failure text, a timeout), or no reason when the window was closed.
 * `runTask`: tasks run one at a time across ALL platforms, in a window of that platform's partition that is created
 * for the task and destroyed when it ends (also when it throws). The task must settle; if the window is closed
 * (only possible when `visible`) `runTask` rejects with 'Window closed'. `url` must be http(s).
 */
import type { ConnectResult, Platform, SocialStatus } from '@/src/desktop/types';
import type { WebContents } from 'electron';
import { SIGNED_OUT } from './read.ts';
import { HOME_URL, SOCIAL_PLATFORMS } from './sessions.ts';
import type { ReadStore } from './store.ts';
import type { SocialWindow, TaskQueue } from './window.ts';

export { SIGNED_OUT };

export interface SocialService {
  status(): Promise<Record<Platform, SocialStatus>>;
  connect(platform: Platform): Promise<ConnectResult>;
  read(platform: Platform): Promise<ConnectResult>;
  openWindow(platform: Platform): Promise<void>;
  signOut(platform?: Platform): Promise<void>;
  runTask<T>(
    platform: Platform,
    opts: { url: string; visible?: boolean },
    task: (wc: WebContents) => Promise<T>,
  ): Promise<T>;
  onPageMessage(wc: WebContents, cb: (raw: string) => void): () => void;
}

export interface RunReadArgs {
  platform: Platform;
  interactive: boolean;
  startedVisible: boolean;
  win: SocialWindow;
}

export interface ServiceDeps {
  queue: TaskQueue<SocialWindow>;
  isSignedIn(platform: Platform): Promise<boolean>;
  clearSession(platform: Platform): Promise<void>;
  store: ReadStore;
  runRead(args: RunReadArgs): Promise<ConnectResult>;
  onPageMessage(wc: WebContents, cb: (raw: string) => void): () => void;
  now?: () => Date;
}

const isHttp = (url: string): boolean => /^https?:\/\//i.test(url);

export function createSocialService(deps: ServiceDeps): SocialService {
  const now = deps.now ?? (() => new Date());

  const finishRead = (platform: Platform, result: ConnectResult): ConnectResult => {
    if (result.ok) deps.store.set(platform, now().toISOString());
    return result;
  };

  const closedPromise = (win: SocialWindow): Promise<never> =>
    new Promise((_, reject) => win.onClosed(() => reject(new Error('Window closed'))));

  return {
    async status() {
      const out = {} as Record<Platform, SocialStatus>;
      await Promise.all(
        SOCIAL_PLATFORMS.map(async (p) => {
          out[p] = { signedIn: await deps.isSignedIn(p), lastReadAt: deps.store.get(p) };
        }),
      );
      return out;
    },

    async connect(platform) {
      const signedIn = await deps.isSignedIn(platform);
      // Signed out: the login page is expected, so the window is visible from the start. Signed in: hidden; it is only
      // shown if the platform sends it to a login page / checkpoint.
      return deps.queue
        .run(platform, { visible: !signedIn }, (win) =>
          deps.runRead({ platform, interactive: true, startedVisible: !signedIn, win }),
        )
        .then((r) => finishRead(platform, r));
    },

    async read(platform) {
      if (!(await deps.isSignedIn(platform))) return { ok: false, reason: SIGNED_OUT };
      return deps.queue
        .run(platform, { visible: false }, (win) =>
          deps.runRead({ platform, interactive: false, startedVisible: false, win }),
        )
        .then((r) => finishRead(platform, r));
    },

    openWindow(platform) {
      // Resolves once the window is up; the task (and the queue slot) lasts until the person closes it.
      return new Promise<void>((resolve) => {
        deps.queue
          .run(platform, { visible: true }, async (win) => {
            const closed = new Promise<void>((done) => win.onClosed(done));
            win.show();
            win.loadUrl(HOME_URL[platform]).catch(() => undefined);
            resolve();
            await closed;
          })
          .catch(() => undefined)
          .finally(resolve);
      });
    },

    async signOut(platform) {
      const list = platform ? [platform] : SOCIAL_PLATFORMS;
      for (const p of list) {
        await deps.clearSession(p);
        deps.store.clear(p);
      }
    },

    runTask(platform, opts, task) {
      if (!isHttp(opts.url)) return Promise.reject(new Error('Invalid url'));
      const visible = opts.visible === true;
      return deps.queue.run(platform, { visible }, async (win) => {
        const closed = closedPromise(win);
        closed.catch(() => undefined); // never an unhandled rejection when the task wins the race
        const work = (async () => {
          await win.loadUrl(opts.url);
          return task(win.webContents);
        })();
        work.catch(() => undefined); // same, when the window closes first
        return Promise.race([work, closed]);
      });
    },

    onPageMessage: (wc, cb) => deps.onPageMessage(wc, cb),
  };
}

let instance: SocialService | null = null;

/** Set once by `registerSocial` (index.ts). */
export function setSocial(service: SocialService | null): void {
  instance = service;
}

export function getSocial(): SocialService {
  if (!instance) throw new Error('Social service is not initialised');
  return instance;
}
