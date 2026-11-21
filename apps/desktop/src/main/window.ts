import type { BrowserWindowConstructorOptions } from 'electron';

/** The app's canvas colour (`colors.bg` in apps/mobile/src/theme.ts): window background and Windows overlay fill. */
export const WINDOW_BG = '#0b1020';
/** Light symbol colour for the Windows min/max/close glyphs (`colors.text`). */
const OVERLAY_SYMBOL = '#f4f6ff';

/**
 * Immersive title bar for the main window: the app's dark UI reaches the top edge. macOS keeps the traffic lights
 * (inset over the sidebar); Windows keeps native min/max/close as an overlay; Linux keeps the normal frame.
 * `height` must match the renderer's drag strip (DESKTOP_TITLEBAR_HEIGHT).
 */
export function titleBarOptions(platform: NodeJS.Platform, height: number): BrowserWindowConstructorOptions {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: Math.round((height - 14) / 2) } };
  }
  if (platform === 'win32') {
    return { titleBarStyle: 'hidden', titleBarOverlay: { color: WINDOW_BG, symbolColor: OVERLAY_SYMBOL, height } };
  }
  return {};
}
