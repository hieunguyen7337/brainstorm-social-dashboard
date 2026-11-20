import { StyleSheet, View } from 'react-native';

import { InstallBar, useInstallBanner } from '@/src/components/room/InstallBanner';
import { RoomWelcomeBar } from '@/src/components/room/RoomWelcome';
import { useRoomWelcome } from '@/src/components/room/roomStore';
import { useWide } from '@/src/layout';
import { space } from '@/src/theme';

/**
 * Slim notices above the Dashboard content, welcome first, install tip below it. Never a modal and never over the content;
 * renders nothing (no gap either) when neither is due.
 */
export function TopBanners() {
  const wide = useWide();
  const welcome = useRoomWelcome();
  const install = useInstallBanner();
  if (!welcome.visible && !install.kind) return null;
  return (
    // Wide: the bare screen floats its refresh button in the top-right gutter; start below it so nothing overlaps.
    <View style={[styles.stack, wide && styles.stackWide]}>
      {welcome.visible ? <RoomWelcomeBar onDismiss={welcome.dismiss} /> : null}
      {install.kind ? <InstallBar kind={install.kind} onDismiss={install.dismiss} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.sm },
  stackWide: { marginTop: space.lg },
});
