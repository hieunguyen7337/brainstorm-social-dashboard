import { useRouter } from 'expo-router';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { autoReadAvailable } from '@/src/autoRead';
import { useSession } from '@/src/session';
import { space, type as t } from '@/src/theme';
import { Button, Card, SectionHeader } from '@/src/ui';

/**
 * Settings entry for "Let Claude use your phone's browser" (src/browserControl). Android app only, and only in an app
 * build that has the WebView (the same check as the in-app sign-in), so it renders nothing on the web and on iOS.
 */
export function BrowserControlCard() {
  const router = useRouter();
  const { token, mock } = useSession();
  if (Platform.OS !== 'android' || !autoReadAvailable() || mock || !token) return null;
  return (
    <View style={styles.wrap} testID="browser-control-card">
      <SectionHeader title="Let Claude use your phone's browser" />
      <Card style={styles.card}>
        <Text style={t.dim}>
          When Pulse can&apos;t read your numbers or post by itself, Claude (with the Pulse connector) can open your
          signed-in Instagram, LinkedIn and others here, and tap and type for you. It only works while that screen is
          open, you see every step, Claude never types passwords, and Stop ends it at once.
        </Text>
        <Button
          title="Start"
          icon="phone-portrait-outline"
          onPress={() => router.push('/browser')}
          full
          accessibilityLabel="Let Claude use your phone's browser"
        />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  card: { gap: space.md },
});
