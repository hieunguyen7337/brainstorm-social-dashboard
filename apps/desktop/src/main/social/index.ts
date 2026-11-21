import { DESKTOP_READ_PLATFORMS, IPC } from '@/src/desktop/types';
import type { ConnectResult, Platform, SocialStatus } from '@/src/desktop/types';
import type { AppContext } from '../context';

/** Stub (unit D2 replaces the bodies). */
export function registerSocial(ctx: AppContext): void {
  ctx.handle(IPC.socialStatus, () => {
    const out = {} as Record<Platform, SocialStatus>;
    for (const p of DESKTOP_READ_PLATFORMS) out[p] = { signedIn: false, lastReadAt: null };
    return out;
  });
  ctx.handle(IPC.socialConnect, (): ConnectResult => ({ ok: false, reason: 'Not available yet' }));
  ctx.handle(IPC.socialOpen, () => undefined);
  ctx.handle(IPC.socialSignOut, () => undefined);
}
