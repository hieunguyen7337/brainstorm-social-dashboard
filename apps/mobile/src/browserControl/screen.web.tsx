/**
 * Web build of "Let Claude use your phone's browser": not available (it needs the Android app's WebView). Keeping this
 * file free of react-native-webview / react-native-view-shot keeps both out of the web bundle; Metro picks it on web.
 */
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space } from '@/src/theme';

export function BrowserControlScreen() {
  const router = useRouter();
  return (
    <View style={styles.root}>
      <Text style={styles.title}>This works in the Pulse Android app only.</Text>
      <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))} style={styles.btn}>
        <Text style={styles.btnText}>Back</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  btn: { paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: colors.cardHi },
  btnText: { color: colors.text, fontWeight: '700' },
});
