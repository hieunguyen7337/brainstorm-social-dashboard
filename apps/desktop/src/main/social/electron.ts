/**
 * Electron side of the social module: session setup and the social BrowserWindow. Not unit-tested (needs Electron);
 * everything with logic lives in the pure modules next to it.
 *
 * Hidden-window painting (macOS): windows are created with `show: false` and `backgroundThrottling: false`, so scripts
 * and timers keep running. `capturePage()` is called with its default (`stayHidden: false`), which makes Electron render
 * the page for the capture. If a capture still comes back empty, `captureWindow` shows the window once, off-screen
 * (-10000, -10000) and not focused, captures again, and hides it. Unverified on real hardware: owner check.
 */
import { app, BrowserWindow, session, type NativeImage, type Session } from 'electron';
import path from 'node:path';
import type { Platform } from '@/src/desktop/types';
import { imageToJpegBase64, type CaptureLimits } from './capture';
import { cleanUserAgent, isSignedIn, partitionFor } from './sessions';
import type { SocialWindow } from './window';

const configured = new Set<Platform>();

export function sessionFor(platform: Platform): Session {
  const ses = session.fromPartition(partitionFor(platform));
  if (!configured.has(platform)) {
    configured.add(platform);
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent(), [app.getName(), app.getName().replace(/\s+/g, '-'), 'pulse-desktop']));
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  }
  return ses;
}

export const signedInOnDisk = (platform: Platform): Promise<boolean> => isSignedIn(sessionFor(platform).cookies, platform);

export async function clearSession(platform: Platform): Promise<void> {
  const ses = sessionFor(platform);
  await ses.clearStorageData();
  await ses.clearCache();
}

const isWeb = (url: string): boolean => /^https?:\/\//i.test(url);

export interface ElectronSocialWindow extends SocialWindow {
  readonly browserWindow: BrowserWindow;
  capture(limits: CaptureLimits): Promise<string>;
}

export function createSocialWindow(platform: Platform, visible: boolean): ElectronSocialWindow {
  const ses = sessionFor(platform);
  const webPreferences = {
    session: ses,
    preload: path.join(__dirname, 'preload-social.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    backgroundThrottling: false,
  };
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    title: `Pulse: ${platform}`,
    backgroundColor: '#ffffff',
    webPreferences,
  });
  const wc = win.webContents;
  const children = new Set<BrowserWindow>();
  const closedCbs: Array<() => void> = [];
  let ours = false;

  // Popups (OAuth, "Continue with ...") stay in this partition; a hidden task never opens one on screen.
  wc.setWindowOpenHandler(({ url }) =>
    win.isVisible() && isWeb(url)
      ? { action: 'allow', overrideBrowserWindowOptions: { show: true, webPreferences } }
      : { action: 'deny' },
  );
  wc.on('did-create-window', (child) => {
    children.add(child);
    child.on('closed', () => children.delete(child));
  });
  // App deep links (instagram://, intent://) are dropped, as on Android.
  const blockNonWeb = (event: { preventDefault(): void }, url: string) => {
    if (!isWeb(url) && url !== 'about:blank') event.preventDefault();
  };
  wc.on('will-navigate', blockNonWeb);
  wc.on('will-redirect', blockNonWeb);

  win.on('closed', () => {
    if (ours) return;
    for (const cb of closedCbs) cb();
  });
  if (visible) win.show();

  return {
    webContents: wc,
    browserWindow: win,
    show() {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    },
    hide() {
      if (!win.isDestroyed()) win.hide();
    },
    destroy() {
      ours = true;
      for (const c of children) if (!c.isDestroyed()) c.destroy();
      if (!win.isDestroyed()) win.destroy();
    },
    async loadUrl(url) {
      try {
        await wc.loadURL(url);
      } catch (e) {
        const err = e as { code?: string; errno?: number };
        if (err.code !== 'ERR_ABORTED' && err.errno !== -3) throw e;
      }
    },
    onClosed(cb) {
      closedCbs.push(cb);
    },
    capture: (limits) => captureWindow(win, limits),
  };
}

async function captureWindow(win: BrowserWindow, limits: CaptureLimits): Promise<string> {
  let image: NativeImage = await win.webContents.capturePage();
  if (image.isEmpty() && !win.isVisible()) {
    const [x, y] = win.getPosition();
    try {
      win.setPosition(-10000, -10000);
      win.showInactive();
      await new Promise((r) => setTimeout(r, 400));
      image = await win.webContents.capturePage();
    } finally {
      if (!win.isDestroyed()) {
        win.hide();
        win.setPosition(x, y);
      }
    }
  }
  return imageToJpegBase64(image, limits);
}
