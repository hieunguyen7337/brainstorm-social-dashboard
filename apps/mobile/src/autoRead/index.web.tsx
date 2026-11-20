/**
 * Web build of the auto-read module: not available. A WebView cannot read another site on the web, and keeping this file
 * free of `react-native-webview` / `react-native-view-shot` (which pulls in html2canvas) keeps both out of the web bundle.
 * Metro picks this file instead of `index.tsx` for the web platform; the API is identical.
 */
import type { AutoReadSheetProps } from './types';

export { AUTO_READ_FAILED } from './types';
export type { AutoReadSheetProps, DeviceRead, ReadPost, ScreenshotRead } from './types';

/** Always false on web. */
export function autoReadAvailable(): boolean {
  return false;
}

/** Renders nothing on web. */
export function AutoReadSheet(_props: AutoReadSheetProps): null {
  return null;
}
