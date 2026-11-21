/**
 * How a confirmed Assistant post reaches Instagram: the same device paths the Create and Queue buttons use
 * (`src/igPost`), chosen by this pure rule. No react-native import.
 *   - autopost: Android only, behind IG_AUTOPOST: the signed-in WebView in `IgPostSheet` publishes it.
 *   - share: the OS share sheet with the photo (expo-sharing); the person finishes in Instagram.
 *   - open_app: this build cannot share files (or no photo picker): open Instagram, the caption is on the clipboard.
 */
export type HandoffRoute = 'autopost' | 'share' | 'open_app';

export function handoffRoute(o: {
  os: string;
  autopost: boolean;
  autopostAvailable: boolean;
  canShare: boolean;
  hasPhoto: boolean;
}): HandoffRoute {
  if (o.hasPhoto && o.os === 'android' && o.autopost && o.autopostAvailable) return 'autopost';
  if (o.hasPhoto && o.canShare) return 'share';
  return 'open_app';
}

/** The confirm button says what it really does: autopost publishes, the others hand over to Instagram. */
export function confirmLabel(route: HandoffRoute): string {
  return route === 'autopost' ? 'Post to Instagram' : route === 'share' ? 'Share to Instagram' : 'Open Instagram';
}
