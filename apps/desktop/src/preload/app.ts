import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { DESKTOP_BRIDGE_VERSION, IPC } from '@/src/desktop/types';
import type { ClaudeEvent, PublishConfirmRequest, PulseDesktop } from '@/src/desktop/types';

const apiArg = process.argv.find((a) => a.startsWith('--pulse-api-url='));
const apiUrl = (apiArg ? apiArg.slice('--pulse-api-url='.length) : 'https://pulse-hackathon.fly.dev').replace(/\/+$/, '');

const api: PulseDesktop = {
  version: DESKTOP_BRIDGE_VERSION,
  apiUrl,
  social: {
    status: () => ipcRenderer.invoke(IPC.socialStatus),
    connect: (platform) => ipcRenderer.invoke(IPC.socialConnect, platform),
    openWindow: (platform) => ipcRenderer.invoke(IPC.socialOpen, platform),
    signOut: (platform) => ipcRenderer.invoke(IPC.socialSignOut, platform),
  },
  claude: {
    status: () => ipcRenderer.invoke(IPC.claudeStatus),
    run: (req) => ipcRenderer.invoke(IPC.claudeRun, req),
    onEvent: (runId, cb) => {
      const listener = (_e: IpcRendererEvent, id: string, event: ClaudeEvent) => {
        if (id === runId) cb(event);
      };
      ipcRenderer.on(IPC.claudeEvent, listener);
      return () => {
        ipcRenderer.removeListener(IPC.claudeEvent, listener);
      };
    },
    stop: (runId) => ipcRenderer.invoke(IPC.claudeStop, runId),
    chooseBinary: () => ipcRenderer.invoke(IPC.claudeChoose),
  },
  confirm: {
    onRequest: (cb) => {
      const listener = (_e: IpcRendererEvent, req: PublishConfirmRequest) => cb(req);
      ipcRenderer.on(IPC.confirmRequest, listener);
      return () => {
        ipcRenderer.removeListener(IPC.confirmRequest, listener);
      };
    },
    respond: (id, answer) => ipcRenderer.invoke(IPC.confirmRespond, id, answer),
  },
  setWorkspaceToken: (token) => ipcRenderer.invoke(IPC.setToken, token),
};

contextBridge.exposeInMainWorld('pulseDesktop', api);
