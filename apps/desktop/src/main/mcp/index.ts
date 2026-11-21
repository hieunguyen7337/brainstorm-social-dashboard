import { IPC } from '@/src/desktop/types';
import type { AppContext } from '../context';

/** Stub (unit D4 replaces the body). */
export function registerMcp(ctx: AppContext): void {
  ctx.handle(IPC.confirmRespond, () => undefined);
}
