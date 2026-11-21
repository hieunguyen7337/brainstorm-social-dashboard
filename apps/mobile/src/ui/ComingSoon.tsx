import { StyleSheet, Text, View } from 'react-native';

import { comingSoonLine, UPCOMING_PLATFORMS } from '@/src/platforms';
import { colors, type as t } from '@/src/theme';

/** One muted "Coming soon: X, TikTok, Facebook, Reddit" line (renders nothing when every platform is live). */
export function ComingSoonLine({ testID = 'coming-soon-line' }: { testID?: string }) {
  if (UPCOMING_PLATFORMS.length === 0) return null;
  return (
    <View style={styles.wrap}>
      <Text testID={testID} style={[t.small, styles.text]}>
        {comingSoonLine()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingVertical: 2 },
  text: { color: colors.textMute },
});
