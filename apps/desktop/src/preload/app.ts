import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { DESKTOP_BRIDGE_VERSION, IPC } from '@/src/desktop/types';
import type { ClaudeEvent, PublishConfirmRequest, PulseDesktop } from '@/src/desktop/types';

const apiArg = process.argv.find((a) => a.startsWith('--pulse-api-url='));
const apiUrl = (apiArg ? apiArg.slice('--pulse-api-url='.length) : 'https://pulse-hackathon.fly.dev').replace(/\/+$/, '');

// Claude events can arrive before the app subscribes (run() resolves first), so a run's events wait here until it does.
const MAX_PENDING_EVENTS = 5000;
const runListeners = new Map<string, Set<(e: ClaudeEvent) => void>>();
const pendingEvents = new Map<string, ClaudeEvent[]>();
ipcRenderer.on(IPC.claudeEvent, (_e: IpcRendererEvent, id: string, event: ClaudeEvent) => {
  const listeners = runListeners.get(id);
  if (listeners && listeners.size > 0) {
    for (const cb of listeners) cb(event);
    return;
  }
  const queue = pendingEvents.get(id) ?? [];
  if (queue.length < MAX_PENDING_EVENTS) queue.push(event);
  pendingEvents.set(id, queue);
});

const api: PulseDesktop = {
  version: DESKTOP_BRIDGE_VERSION,
  platform: process.platform,
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
      const listeners = runListeners.get(runId) ?? new Set();
      listeners.add(cb);
      runListeners.set(runId, listeners);
      const queued = pendingEvents.get(runId);
      pendingEvents.delete(runId);
      for (const event of queued ?? []) cb(event);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) runListeners.delete(runId);
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
