import { app, BrowserWindow, net, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { API_URL, APP_HOST, APP_SCHEME, APP_URL } from './config';
import { createContext } from './context';
import { registerIpc } from './ipc';
import { contentTypeFor, resolveRendererPath } from './paths';

const ROOT = path.resolve(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'renderer');

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow: BrowserWindow | null = null;

function html(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function missingRendererPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>Pulse</title>
<body style="background:#0f1020;color:#eee;font:16px system-ui;padding:48px">
<h1>Pulse web build not found</h1>
<p>Run <code>npm run renderer</code> in <code>apps/desktop</code>, then restart the app.</p></body>`;
}

async function serveApp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== APP_HOST) return html(404, 'Not found');
  if (!fs.existsSync(path.join(RENDERER_DIR, 'index.html'))) return html(500, missingRendererPage());
  const file = resolveRendererPath(RENDERER_DIR, url.pathname);
  if (!file) return html(403, 'Forbidden');
  const target = file;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    // Missing asset (has an extension) is a real 404; routes already fell back to index.html.
    return html(404, 'Not found');
  }
  const res = await net.fetch(pathToFileURL(target).toString());
  const headers = new Headers(res.headers);
  headers.set('content-type', contentTypeFor(target));
  return new Response(res.body, { status: res.status, headers });
}

function isAppUrl(url: string): boolean {
  return url.startsWith(APP_URL);
}

function openExternalIfWeb(url: string): void {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(u.toString());
  } catch {
    // ignore malformed URLs
  }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1020',
    title: 'Pulse',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload-app.js'),
      additionalArguments: [`--pulse-api-url=${API_URL}`],
    },
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalIfWeb(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadURL(APP_URL);
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, serveApp);
    registerIpc(createContext(() => mainWindow));
    mainWindow = createMainWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
