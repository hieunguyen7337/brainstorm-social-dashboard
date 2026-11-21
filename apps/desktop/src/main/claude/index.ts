import { IPC } from '@/src/desktop/types';
import type { ClaudeState } from '@/src/desktop/types';
import type { AppContext } from '../context';

/** Stub (unit D3 replaces the bodies). */
export function registerClaude(ctx: AppContext): void {
  const notFound = (): ClaudeState => ({ state: 'not_found' });
  ctx.handle(IPC.claudeStatus, notFound);
  ctx.handle(IPC.claudeRun, () => Promise.reject(new Error('not available')));
  ctx.handle(IPC.claudeStop, () => undefined);
  ctx.handle(IPC.claudeChoose, notFound);
}
