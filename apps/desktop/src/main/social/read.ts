/**
 * One sign-in-and-read run inside a social window: wires the autoRead runner to a window host and decides when the
 * window may be visible. Pure (runner and host are injected) so the decisions are tested without Electron.
 *
 * Visibility rules (owner decision, docs/DESKTOP.md 3):
 *  - The runner always starts on the platform's login URL and reports status 'login' at once, even when the person is
 *    signed in (the platform then redirects to the feed). So an initial 'login' gets a grace period before it counts.
 *  - Still on a login page after the grace period, or back on one after reading began (signed out / checkpoint / 2FA):
 *    interactive runs show the window so the person can handle it; background runs never show it and end with
 *    `{ ok: false, reason: SIGNED_OUT }`.
 *  - Once the window has been shown it stays visible: later non-login statuses (a checkpoint/2FA page that classifies
 *    as past login, a signed_out blip) do not hide it. It is hidden only when the run finishes with a confirmed
 *    signed-in result (`ok`); other outcomes are left to the task-end teardown.
 *  - Closing a visible window ends the run with `{ ok: false }` (no reason).
 */
import type { ConnectResult, DeviceRead, Platform } from '@/src/desktop/types';
import type { ScreenshotRead } from '@/src/types';

/** `reason` of a background read that found the person signed out (machine-readable; the connect card maps it). */
export const SIGNED_OUT = 'signed_out';

export type RunnerStatusLike = 'anon' | 'login' | 'reading' | 'capturing' | 'claude';

/** The subset of the autoRead runner this module drives. */
export interface RunnerLike {
  start(): void;
  navigated(url: string, loading: boolean): void;
  loadEnded(url: string): void;
  loadFailed(url: string | null | undefined): void;
  message(raw: unknown): void;
  dispose(): void;
}

export interface RunnerDepsLike {
  platform: Platform;
  loadUrl(url: string): void;
  inject(script: string): void;
  capture(): Promise<string>;
  readScreenshot(base64: string, mediaType: 'image/jpeg'): Promise<ScreenshotRead>;
  emitResult(read: DeviceRead): void;
  emitClose(reason?: string): void;
  onStatus(status: RunnerStatusLike): void;
}

/** The window as the read flow sees it. */
export interface ReadHost {
  show(): void;
  hide(): void;
  loadUrl(url: string): void;
  inject(script: string): void;
  capture(): Promise<string>;
  onClosed(cb: () => void): void;
  onPage(events: {
    navigated(url: string, loading: boolean): void;
    loadEnded(url: string): void;
    loadFailed(url: string | null | undefined): void;
  }): void;
  /** Raw page messages from this window's shim (already filtered by sender). */
  onMessage(cb: (raw: string) => void): void;
}

export interface ReadOptions {
  platform: Platform;
  /** The person is present: a login/checkpoint page may show the window. False: never show it. */
  interactive: boolean;
  /** The window was created visible (the person is signed out; login is expected). */
  startedVisible: boolean;
  host: ReadHost;
  makeRunner(deps: RunnerDepsLike): RunnerLike;
  readScreenshot(base64: string, mediaType: 'image/jpeg'): Promise<ScreenshotRead>;
  /** The Android sheet's href poll (hrefPoll.ts): a signed-in Instagram rewrites its login URL inside the page. */
  href: { js: string; ms: number; take(data: unknown): string | null };
  /** Initial 'login' status is ignored this long (a signed-in session is redirected to the feed meanwhile). */
  graceMs?: number;
  /** Hidden runs give up after this long. */
  capMs?: number;
  failedReason: string;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(id: unknown): void;
  setPoll?(fn: () => void, ms: number): unknown;
  clearPoll?(id: unknown): void;
}

export const LOGIN_GRACE_MS = 8_000;
export const HIDDEN_CAP_MS = 120_000;

export function readInWindow(o: ReadOptions): Promise<ConnectResult> {
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const setPoll = o.setPoll ?? ((fn, ms) => setInterval(fn, ms));
  const clearPoll = o.clearPoll ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));

  return new Promise<ConnectResult>((resolve) => {
    let settled = false;
    let shown = o.startedVisible;
    let sawNonLogin = false;
    let graceTimer: unknown = null;
    let capTimer: unknown = null;
    let poll: unknown = null;
    let runner: RunnerLike | null = null;

    const stopPoll = () => {
      if (poll !== null) clearPoll(poll);
      poll = null;
    };
    const stopGrace = () => {
      if (graceTimer !== null) clearTimer(graceTimer);
      graceTimer = null;
    };
    const stopCap = () => {
      if (capTimer !== null) clearTimer(capTimer);
      capTimer = null;
    };

    const finish = (result: ConnectResult) => {
      if (settled) return;
      settled = true;
      stopPoll();
      stopGrace();
      stopCap();
      if (result.ok && shown) {
        shown = false;
        o.host.hide();
      }
      runner?.dispose();
      resolve(result);
    };

    const loginNeeded = () => {
      if (settled) return;
      if (o.interactive) {
        if (!shown) {
          shown = true;
          o.host.show();
        }
        stopCap(); // the person takes as long as they need
      } else {
        finish({ ok: false, reason: SIGNED_OUT });
      }
    };

    const onStatus = (status: RunnerStatusLike) => {
      if (settled) return;
      if (status === 'login') {
        if (poll === null) poll = setPoll(() => o.host.inject(o.href.js), o.href.ms);
        if (shown) return;
        if (sawNonLogin) loginNeeded();
        else if (graceTimer === null) graceTimer = setTimer(() => ((graceTimer = null), loginNeeded()), o.graceMs ?? LOGIN_GRACE_MS);
        return;
      }
      sawNonLogin = true;
      stopPoll();
      stopGrace();
    };

    o.host.onClosed(() => finish({ ok: false }));
    o.host.onMessage((raw) => {
      if (settled || !runner) return;
      const href = o.href.take(raw);
      if (href) runner.navigated(href, false);
      else runner.message(raw);
    });
    o.host.onPage({
      navigated: (url, loading) => runner?.navigated(url, loading),
      loadEnded: (url) => runner?.loadEnded(url),
      loadFailed: (url) => runner?.loadFailed(url),
    });

    runner = o.makeRunner({
      platform: o.platform,
      loadUrl: (url) => o.host.loadUrl(url),
      inject: (js) => o.host.inject(js),
      capture: () => o.host.capture(),
      readScreenshot: (b, m) => o.readScreenshot(b, m),
      emitResult: (read) => finish({ ok: true, read }),
      emitClose: (reason) => finish(reason ? { ok: false, reason } : { ok: false }),
      onStatus,
    });
    if (!o.startedVisible) {
      capTimer = setTimer(() => finish({ ok: false, reason: o.failedReason }), o.capMs ?? HIDDEN_CAP_MS);
    }
    runner.start();
  });
}
