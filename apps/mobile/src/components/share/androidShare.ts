/**
 * Android: hand a post straight to LinkedIn's own "Share in a post" composer, text and link filled in.
 *
 * The composer URL (`linkedin.com/feed/?shareActive=true&text=`) only works on the web: LinkedIn's Android app opens
 * its feed and drops the text (vivo, 2026-11-21). An ACTION_SEND aimed at LinkedIn's sharing activity opens the
 * composer with the text, so posting is one tap in Pulse plus LinkedIn's own Post button.
 *
 * expo-intent-launcher is native: builds made before it was added do not have it, and an OTA reaches them too
 * (runtimeVersion is the app version). So it is required lazily, and without it the phone's share sheet is used.
 */
import { Share } from 'react-native';

export const LINKEDIN_PACKAGE = 'com.linkedin.android';
export const LINKEDIN_POST_ACTIVITY = 'com.linkedin.android.publishing.sharing.SharingDeepLinkActivity';

type Launcher = { startActivityAsync: (action: string, params?: Record<string, unknown>) => Promise<unknown> };

function launcher(): Launcher | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-intent-launcher') as Launcher;
  } catch {
    return null; // an older build without the native module
  }
}

/** True when LinkedIn's composer (or the share sheet) was shown with the text; false when nothing could open. */
export async function shareToLinkedInAndroid(text: string): Promise<boolean> {
  const il = launcher();
  if (il) {
    const send = { type: 'text/plain', extra: { 'android.intent.extra.TEXT': text } };
    try {
      await il.startActivityAsync('android.intent.action.SEND', {
        ...send,
        packageName: LINKEDIN_PACKAGE,
        className: LINKEDIN_POST_ACTIVITY,
      });
      return true;
    } catch {
      // LinkedIn renamed the activity or is not installed: fall through to the share sheet
    }
  }
  try {
    const result = await Share.share({ message: text });
    return result.action !== Share.dismissedAction;
  } catch {
    return false;
  }
}
