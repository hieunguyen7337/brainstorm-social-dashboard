import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '@/src/desktop/types';
import { API_URL } from './config';
import { isAppSender } from './sender';

export { isAppSender };

export interface AppContext {
  apiUrl: string;
  getToken(): string | null;
  getMainWindow(): BrowserWindow | null;
  sendToApp(channel: string, ...args: unknown[]): void;
  /** `ipcMain.handle` that rejects callers outside `app://pulse/`. */
  handle(channel: string, fn: (...args: unknown[]) => unknown): void;
}

const MAX_TOKEN_LENGTH = 4096;

export function createContext(getMainWindow: () => BrowserWindow | null): AppContext {
  let token: string | null = null;
  const ctx: AppContext = {
    apiUrl: API_URL,
    getToken: () => token,
    getMainWindow,
    sendToApp(channel, ...args) {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
    },
    handle(channel, fn) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!isAppSender(event.senderFrame?.url)) throw new Error('Forbidden');
        return fn(...args);
      });
    },
  };
  ctx.handle(IPC.setToken, (value) => {
    if (value !== null && (typeof value !== 'string' || value.length > MAX_TOKEN_LENGTH)) {
      throw new Error('Invalid token');
    }
    token = value === '' ? null : (value as string | null);
  });
  return ctx;
}
