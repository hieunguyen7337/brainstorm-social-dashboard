/**
 * Web build of the auto-read module. A WebView cannot read another site on the web, so plain web has no auto-read. Inside
 * Pulse Desktop (docs/DESKTOP.md) the Electron main process signs in and reads in its own window: `AutoReadSheet` just
 * asks the bridge (`social.connect`) and shows a small note. Keeping this file free of `react-native-webview` /
 * `react-native-view-shot` (which pulls in html2canvas) keeps both out of the web bundle.
 * Metro picks this file instead of `index.tsx` for the web platform; the API is identical.
 */
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { getDesktop } from '@/src/desktop';
import { colors, platformMeta, space, type as t } from '@/src/theme';
import type { AutoReadSheetProps } from './types';

export { AUTO_READ_FAILED } from './types';
export type { AutoReadSheetProps, DeviceRead, ReadPost, ScreenshotRead } from './types';

/** True only inside Pulse Desktop. */
export function autoReadAvailable(): boolean {
  return getDesktop() !== null;
}

/**
 * Desktop: opens the platform's login window (or reads hidden, when already signed in) once per opening. The window is the
 * real sign-in UI; this renders only a light note. Results that arrive after `visible` went false are ignored.
 */
export function AutoReadSheet({ platform, visible, onClose, onResult }: AutoReadSheetProps) {
  // The latest callbacks, so the effect below runs only when `visible` / `platform` change.
  const cb = useRef({ onClose, onResult });
  cb.current = { onClose, onResult };

  useEffect(() => {
    const desktop = getDesktop();
    if (!visible || !desktop) return;
    let live = true;
    desktop.social.connect(platform).then(
      (res) => {
        if (!live) return;
        if (res.ok) cb.current.onResult(res.read);
        else cb.current.onClose(res.reason);
      },
      () => {
        if (live) cb.current.onClose("Couldn't open the sign-in window. Try again.");
      },
    );
    return () => {
      live = false;
    };
  }, [visible, platform]);

  if (!visible || !getDesktop()) return null;
  return (
    <View style={styles.note} accessibilityRole="alert" testID="desktop-signin-note">
      <Text style={t.small}>{`Signing in to ${platformMeta[platform].label} in its own window...`}</Text>
    </View>
  );
}

/** Desktop: the main process refreshes connected accounts itself. Nothing to do here. */
export function AutoRefresh(): null {
  return null;
}

/** Desktop: clears every platform's session. Elsewhere there is nothing to forget. */
export function forgetSignIns(): Promise<void> {
  const desktop = getDesktop();
  return desktop ? desktop.social.signOut() : Promise.resolve();
}

const styles = StyleSheet.create({
  note: { paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: 8, backgroundColor: colors.cardHi },
});
