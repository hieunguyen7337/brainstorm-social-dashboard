/**
 * The social task queue. At most one social window exists at a time: a task gets a window created for it and the window
 * is destroyed when the task ends (success, failure or throw). Idle means no window at all.
 * Pure (windows come from an injected factory) so it runs under node:test.
 */
import type { Platform } from '@/src/desktop/types';
import type { WebContents } from 'electron';

/** What the queue and the service need from a social window (the Electron implementation is in `electron.ts`). */
export interface SocialWindow {
  readonly webContents: WebContents;
  show(): void;
  hide(): void;
  destroy(): void;
  /** Resolves when the page has loaded; redirects that abort the first navigation are not errors. */
  loadUrl(url: string): Promise<void>;
  /** Called when the window is closed by the person, or destroyed. Not called for our own `destroy()` after the task. */
  onClosed(cb: () => void): void;
}

export class TaskQueue<W extends { destroy(): void }> {
  private tail: Promise<unknown> = Promise.resolve();
  private active: W | null = null;
  private queued = 0;

  private readonly create: (platform: Platform, visible: boolean) => W;

  constructor(create: (platform: Platform, visible: boolean) => W) {
    this.create = create;
  }

  /** The window of the task that is running now, if any. */
  get current(): W | null {
    return this.active;
  }
  get pending(): number {
    return this.queued;
  }

  run<T>(platform: Platform, opts: { visible: boolean }, task: (win: W) => Promise<T>): Promise<T> {
    this.queued += 1;
    const result = this.tail.then(async () => {
      this.queued -= 1;
      let win: W | null = null;
      try {
        win = this.create(platform, opts.visible);
        this.active = win;
        return await task(win);
      } finally {
        this.active = null;
        try {
          win?.destroy();
        } catch {
          // already gone
        }
      }
    });
    this.tail = result.catch(() => undefined); // a failing task must not block the next one
    return result;
  }

  /** App quit: destroy the running window. */
  dispose(): void {
    try {
      this.active?.destroy();
    } catch {
      // ignore
    }
  }
}
