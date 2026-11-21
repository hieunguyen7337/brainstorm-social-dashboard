import { app, ipcMain } from 'electron';
import path from 'node:path';
import { IPC } from '@/src/desktop/types';
import type { AppContext } from '../context';
import { clearSession, createSocialWindow, signedInOnDisk } from './electron';
import { createMessageHub } from './messages';
import { createRunRead } from './runner';
import { createSocialService, setSocial } from './service';
import { isSocialPlatform } from './sessions';
import { createStore } from './store';
import { TaskQueue } from './window';

function platformArg(v: unknown) {
  if (!isSocialPlatform(v)) throw new Error('Invalid platform');
  return v;
}

/** Social sign-in and reading (docs/DESKTOP.md 4.4). The service API for other modules is in `service.ts`. */
export function registerSocial(ctx: AppContext): void {
  const hub = createMessageHub();
  const queue = new TaskQueue(createSocialWindow);
  const service = createSocialService({
    queue,
    isSignedIn: signedInOnDisk,
    clearSession,
    store: createStore(path.join(app.getPath('userData'), 'social-reads.json')),
    runRead: createRunRead(ctx, hub),
    onPageMessage: (wc, cb) => hub.attach(wc, cb),
  });
  setSocial(service);

  // Page messages from the social windows' shim; only the sender's own task listener gets them.
  ipcMain.on(IPC.pageMessage, (event, raw) => {
    hub.deliver(event.sender, raw);
  });
  app.on('before-quit', () => queue.dispose());

  ctx.handle(IPC.socialStatus, () => service.status());
  ctx.handle(IPC.socialConnect, (platform) => service.connect(platformArg(platform)));
  ctx.handle(IPC.socialOpen, (platform) => service.openWindow(platformArg(platform)));
  ctx.handle(IPC.socialSignOut, (platform) =>
    service.signOut(platform === undefined || platform === null ? undefined : platformArg(platform)),
  );
}
