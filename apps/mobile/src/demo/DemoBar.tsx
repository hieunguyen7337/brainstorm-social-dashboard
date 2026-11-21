/**
 * The notice that is always on the Dashboard of a demo workspace (docs/REAL.md, "Demo workspaces"): every number here is
 * synthetic. It cannot be dismissed; "Start my real workspace" forgets the demo (after a confirm) and returns to onboarding,
 * where "Start my workspace" makes a real one.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';

import { useSession } from '@/src/session';
import { colors, radius, space, type as t, withAlpha } from '@/src/theme';
import { Badge, Button, confirm } from '@/src/ui';

export function DemoBar() {
  const { signOut } = useSession();

  const startReal = async () => {
    const ok = await confirm(
      'Leave the demo?',
      'The demo workspace is forgotten on this device. You can then start your own workspace and connect your real accounts.',
      'Start my real workspace',
      true,
    );
    if (ok) await signOut();
  };

  return (
    <View style={styles.bar} accessibilityRole="alert" testID="demo-bar">
      <View style={styles.text}>
        <Badge label="DEMO" tone="warn" icon="flask-outline" />
        <Text style={[t.small, styles.copy]}>
          <Ionicons name="information-circle-outline" size={13} color={colors.warn} /> Demo workspace: every number is
          synthetic. Nothing here comes from a real account.
        </Text>
      </View>
      <Button small variant="secondary" title="Start my real workspace" onPress={() => void startReal()} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: withAlpha(colors.warn, 0.4),
    backgroundColor: withAlpha(colors.warn, 0.08),
  },
  text: { gap: space.sm },
  copy: { color: colors.text },
});
