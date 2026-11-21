/**
 * Adapter: builds the `RunnerDeps` for the shared autoRead runner (apps/mobile/src/autoRead/runner.ts) from a social
 * window, and runs one read. `clearSession` is deliberately not passed: the sign-in persists (sign-out is explicit).
 * Page contents, cookies and tokens never leave the window; only the reader's `PageMessage` crosses IPC.
 */
import {
  CAPTURE_MAX_BYTES,
  CAPTURE_MAX_WIDTH,
  CAPTURE_QUALITY,
  CAPTURE_RETRY_QUALITY,
  CAPTURE_RETRY_WIDTH,
} from '@/src/autoRead/config';
import { HREF_POLL_JS, HREF_POLL_MS, takeHref } from '@/src/autoRead/hrefPoll';
import { AutoReadRunner } from '@/src/autoRead/runner';
import { AUTO_READ_FAILED } from '@/src/autoRead/types';
import type { ConnectResult } from '@/src/desktop/types';
import type { ScreenshotRead } from '@/src/types';
import type { AppContext } from '../context';
import type { ElectronSocialWindow } from './electron';
import type { MessageHub } from './messages';
import { readInWindow, type RunnerLike } from './read';
import type { RunReadArgs } from './service';

const LIMITS = {
  maxWidth: CAPTURE_MAX_WIDTH,
  quality: CAPTURE_QUALITY,
  retryWidth: CAPTURE_RETRY_WIDTH,
  retryQuality: CAPTURE_RETRY_QUALITY,
  maxBytes: CAPTURE_MAX_BYTES,
};

/** Screenshot fallback: the same endpoint the app uses, called from the main process with the workspace token. */
function readScreenshotWith(ctx: AppContext, platform: string) {
  return async (base64: string, mediaType: 'image/jpeg'): Promise<ScreenshotRead> => {
    const token = ctx.getToken();
    if (!token) throw new Error('Not signed in to Pulse');
    const res = await fetch(`${ctx.apiUrl}/api/connections/${encodeURIComponent(platform)}/screenshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ image_base64: base64, media_type: mediaType }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Screenshot read failed (${res.status})`);
    return (await res.json()) as ScreenshotRead;
  };
}

export function createRunRead(ctx: AppContext, hub: MessageHub) {
  return (args: RunReadArgs): Promise<ConnectResult> => {
    const win = args.win as ElectronSocialWindow;
    const wc = win.webContents;
    return readInWindow({
      platform: args.platform,
      interactive: args.interactive,
      startedVisible: args.startedVisible,
      failedReason: AUTO_READ_FAILED,
      href: { js: HREF_POLL_JS, ms: HREF_POLL_MS, take: takeHref },
      readScreenshot: readScreenshotWith(ctx, args.platform),
      makeRunner: (deps) => new AutoReadRunner(deps) as RunnerLike,
      host: {
        show: () => win.show(),
        hide: () => win.hide(),
        loadUrl: (url) => void win.loadUrl(url).catch(() => undefined),
        inject: (js) => {
          if (!wc.isDestroyed()) wc.executeJavaScript(js).catch(() => undefined);
        },
        capture: () => win.capture(LIMITS),
        onClosed: (cb) => win.onClosed(cb),
        onMessage: (cb) => {
          hub.attach(wc, cb);
        },
        onPage: (ev) => {
          wc.on('did-navigate', (_e, url) => ev.navigated(url, true));
          wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
            if (isMainFrame) ev.navigated(url, false);
          });
          wc.on('did-finish-load', () => ev.loadEnded(wc.getURL()));
          wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
            if (isMainFrame && code !== -3) ev.loadFailed(url);
          });
        },
      },
    });
  };
}
