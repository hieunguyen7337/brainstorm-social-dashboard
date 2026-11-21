import { app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '@/src/desktop/types';
import type { ClaudeState } from '@/src/desktop/types';
import { CLAUDE_BIN } from '../config';
import type { AppContext } from '../context';
import { ClaudeBridge } from './bridge.ts';
import { locateClaude, resolveViaLoginShell, saveBin } from './locate.ts';
import { removeMcpConfig, writeMcpConfig } from './mcpConfig.ts';
import { checkStatus } from './status.ts';

export { setDesktopMcp } from './mcpConfig.ts';

export function registerClaude(ctx: AppContext): void {
  const userData = app.getPath('userData');
  const workDir = path.join(userData, 'claude-workdir');
  const settingsFile = path.join(userData, 'settings.json');
  const mcpFile = path.join(userData, 'mcp.json');
  fs.mkdirSync(workDir, { recursive: true });

  const resolveBin = () => locateClaude({ envBin: CLAUDE_BIN, settingsFile, shellResolve: () => resolveViaLoginShell() });
  const bridge = new ClaudeBridge({
    resolveBin,
    workDir,
    writeMcpConfig: () => writeMcpConfig(mcpFile, ctx.apiUrl, ctx.getToken()),
    send: (runId, event) => ctx.sendToApp(IPC.claudeEvent, runId, event),
  });
  const status = async (): Promise<ClaudeState> => checkStatus(await resolveBin());

  ctx.handle(IPC.claudeStatus, status);
  ctx.handle(IPC.claudeRun, (req) => bridge.run(req));
  ctx.handle(IPC.claudeStop, (runId) => bridge.stop(runId));
  ctx.handle(IPC.claudeChoose, async (): Promise<ClaudeState> => {
    const win = ctx.getMainWindow();
    const filters = process.platform === 'win32'
      ? [{ name: 'Claude Code (claude.exe, claude.cmd)', extensions: ['exe', 'cmd'] }, { name: 'All files', extensions: ['*'] }]
      : undefined;
    const options = { title: 'Choose the claude binary', properties: ['openFile' as const], ...(filters ? { filters } : {}) };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return status();
    const state = await checkStatus(file);
    if (state.state !== 'not_found') saveBin(settingsFile, file);
    return state;
  });

  app.on('before-quit', () => {
    bridge.killAll();
    removeMcpConfig(mcpFile);
  });
}
