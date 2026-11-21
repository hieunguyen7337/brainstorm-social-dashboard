/**
 * Routes the social-window shim's messages (`IPC.pageMessage`) to the task that owns that window. A message from any
 * other webContents (a stray window, the main window, a popup) has no listener and is dropped. Only strings pass.
 */
export interface MessageHub {
  /** Listen to one webContents. Returns the detach function. */
  attach(sender: unknown, cb: (raw: string) => void): () => void;
  /** Called by the ipcMain listener with `event.sender`. Returns whether anyone received it. */
  deliver(sender: unknown, raw: unknown): boolean;
}

export const MAX_MESSAGE_LENGTH = 1_000_000;

export function createMessageHub(): MessageHub {
  const listeners = new Map<unknown, Set<(raw: string) => void>>();
  return {
    attach(sender, cb) {
      let set = listeners.get(sender);
      if (!set) listeners.set(sender, (set = new Set()));
      set.add(cb);
      return () => {
        const s = listeners.get(sender);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) listeners.delete(sender);
      };
    },
    deliver(sender, raw) {
      const set = listeners.get(sender);
      if (!set || typeof raw !== 'string' || raw.length > MAX_MESSAGE_LENGTH) return false;
      for (const cb of [...set]) cb(raw);
      return true;
    },
  };
}
