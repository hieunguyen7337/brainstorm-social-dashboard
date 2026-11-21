/**
 * Pulse Desktop (docs/DESKTOP.md): the Electron preload exposes `window.pulseDesktop`; the app talks to it through here.
 * Everywhere else (plain web, Android, iOS) `getDesktop()` is null and nothing changes. No react-native import, so this
 * is safe to load on native (there `window` has no `pulseDesktop`) and under plain Node.
 */
import { DESKTOP_TITLEBAR_HEIGHT, type PulseDesktop } from './types';

export * from './types';

/** The bridge, or null outside Pulse Desktop. */
export function getDesktop(): PulseDesktop | null {
  const w = (typeof window === 'undefined' ? undefined : window) as (Window & { pulseDesktop?: PulseDesktop }) | undefined;
  const bridge = w?.pulseDesktop;
  return bridge && typeof bridge === 'object' && bridge.version ? bridge : null;
}

export const isDesktop = (): boolean => getDesktop() !== null;

/** The API base the desktop bridge gives (no trailing slash), or null outside Pulse Desktop. */
export function desktopApiUrl(): string | null {
  const url = getDesktop()?.apiUrl;
  return url ? url.replace(/\/+$/, '') : null;
}

/**
 * Px the app must leave free at the top for the immersive title bar (macOS traffic lights, Windows window controls).
 * 0 outside Pulse Desktop and on platforms that keep the native frame (Linux), so web and mobile layouts are unchanged.
 */
export function desktopTitleBarInset(): number {
  const platform = getDesktop()?.platform;
  return platform === 'darwin' || platform === 'win32' ? DESKTOP_TITLEBAR_HEIGHT : 0;
}
