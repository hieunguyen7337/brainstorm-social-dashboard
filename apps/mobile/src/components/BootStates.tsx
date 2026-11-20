import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { APP_NAME } from '@/src/config';
import { useSession } from '@/src/session';
import { colors, space, type as t } from '@/src/theme';
import { Button, ErrorState, Logo } from '@/src/ui';

/** Shown while the saved token is being validated. */
export function SplashView() {
  return (
    <View style={styles.center}>
      <Logo size={64} />
      <Text style={[t.h2, styles.name]}>{APP_NAME}</Text>
      <ActivityIndicator color={colors.accent} style={{ marginTop: space.lg }} />
    </View>
  );
}

/** A saved workspace exists but the server cannot be reached. */
export function OfflineView() {
  const { retry, error, signOut } = useSession();
  return (
    <View style={styles.center}>
      <ErrorState title="Can't reach the server" message={error ?? 'Check your connection and try again.'} onRetry={() => void retry()} />
      <View style={styles.actions}>
        <Button title="Start over" variant="ghost" small onPress={() => void signOut()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  name: { marginTop: space.md },
  actions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', justifyContent: 'center' },
});
