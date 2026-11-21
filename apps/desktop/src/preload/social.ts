import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@/src/desktop/types';

// Same shim the Android WebView provides, so the autoRead reader scripts run unmodified.
contextBridge.exposeInMainWorld('ReactNativeWebView', {
  postMessage: (s: unknown) => ipcRenderer.send(IPC.pageMessage, String(s).slice(0, 1_000_000)),
});
