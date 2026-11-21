/**
 * Pulse Desktop only: the draggable strip along the top of the window. The main process hides the native title bar
 * (macOS traffic lights over the sidebar, Windows controls as an overlay), so this strip is what the person grabs to
 * move the window. Nothing interactive lives in it: screens, the sidebar and onboarding start below `desktopTitleBarInset()`.
 * Renders nothing on web, iOS, Android or on a desktop platform that keeps its native frame.
 */
import { Platform, StyleSheet, View } from 'react-native';

import { desktopTitleBarInset } from '@/src/desktop';

export function DesktopTitleBar() {
  const height = Platform.OS === 'web' ? desktopTitleBarInset() : 0;
  if (!height) return null;
  return <View testID="desktop-titlebar" style={[styles.strip, { height }]} />;
}

const styles = StyleSheet.create({
  strip: { position: 'absolute', top: 0, left: 0, right: 0, ...({ WebkitAppRegion: 'drag' } as object) },
});
