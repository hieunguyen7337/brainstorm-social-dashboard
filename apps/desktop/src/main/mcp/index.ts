import { app, nativeImage } from 'electron';
import * as igLogic from '@/src/igPost/logic';
import { DESKTOP_PUBLISH_PLATFORMS, DESKTOP_READ_PLATFORMS, IPC } from '@/src/desktop/types';
import type { AppContext } from '../context';
import { setDesktopMcp } from '../claude/mcpConfig';
import { createInstagramPoster } from '../social/post';
import { getSocial } from '../social/service';
import { createConfirmer } from './confirm';
import { startMcpServer, type RunningMcp } from './server';
import { createTools } from './tools';

/** The local `pulse_desktop` MCP server (docs/DESKTOP.md 4.6) and the publish-confirm IPC answer. */
export function registerMcp(ctx: AppContext): void {
  const confirmer = createConfirmer({
    send(req) {
      const win = ctx.getMainWindow();
      if (!win || win.isDestroyed()) return false;
      ctx.sendToApp(IPC.confirmRequest, req);
      return true;
    },
    maxBytes: igLogic.IG_MAX_BYTES,
    base64Size: igLogic.base64Size,
  });
  ctx.handle(IPC.confirmRespond, (id, answer) => confirmer.respond(id, answer));

  const social = getSocial();
  const post = createInstagramPoster(social, igLogic, {
    toJpeg: (png) => {
      const img = nativeImage.createFromBuffer(png);
      return img.isEmpty() ? null : img.toJPEG(90);
    },
  });
  const tools = createTools({
    apiUrl: ctx.apiUrl,
    getToken: ctx.getToken,
    hasWindow: () => {
      const win = ctx.getMainWindow();
      return !!win && !win.isDestroyed();
    },
    status: () => social.status(),
    read: (p) => social.read(p),
    confirm: (req) => confirmer.ask(req),
    post,
    fetch: (...a) => fetch(...a),
    now: Date.now,
    readPlatforms: DESKTOP_READ_PLATFORMS,
    publishPlatforms: DESKTOP_PUBLISH_PLATFORMS,
  });

  let running: RunningMcp | null = null;
  startMcpServer(tools)
    .then((server) => {
      running = server;
      setDesktopMcp({ url: server.url, token: server.token });
      console.log(`[pulse] desktop MCP server listening at ${server.url}`);
    })
    .catch((err: unknown) => {
      console.error('[pulse] desktop MCP server failed to start:', err instanceof Error ? err.message : 'unknown error');
    });
  app.on('before-quit', () => {
    setDesktopMcp(null);
    void running?.close();
    running = null;
  });
}
