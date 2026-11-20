import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type } from '@/src/theme';

const DISMISS_KEY = 'pulse.iosHint.dismissed';

/** iPhone / iPad browser, not already opened from the Home Screen, not dismissed before. Web only, browser only. */
function shouldShow(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports a Mac user agent; touch support tells them apart.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
  if (!ios) return false;
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true;
  if (standalone) return false;
  try {
    if (localStorage.getItem(DISMISS_KEY)) return false;
  } catch {
    /* storage blocked: still show, it only costs a tap */
  }
  return true;
}

/**
 * iPhone has no installable build (no Apple Developer account), so on iOS browsers Pulse tells people once, in one
 * line, how to keep it on the Home Screen. Points down at Safari's bottom toolbar, where the Share button sits.
 */
export function IosInstallHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!shouldShow()) return;
    const t = setTimeout(() => setVisible(true), 4000);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* storage blocked */
    }
  };

  return (
    <View style={styles.wrap} pointerEvents="box-none" testID="ios-install-hint">
      <View style={styles.card}>
        <Ionicons name="phone-portrait-outline" size={22} color={colors.accent} />
        <Text style={[type.body, styles.text]}>
          Keep Pulse on your Home Screen: tap <Ionicons name="share-outline" size={16} color={colors.text} />{' '}
          <Text style={styles.bold}>Share</Text>, then <Text style={styles.bold}>Add to Home Screen</Text>.
        </Text>
        <Pressable onPress={dismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Dismiss">
          <Ionicons name="close" size={20} color={colors.textDim} />
        </Pressable>
      </View>
      <View style={styles.arrow} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    bottom: space.md,
    alignItems: 'center',
    zIndex: 1000,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    width: '100%',
    maxWidth: 480,
    backgroundColor: colors.cardHi,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
  },
  text: { flex: 1 },
  bold: { fontWeight: '700' },
  arrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 10,
    borderRightWidth: 10,
    borderTopWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: colors.accent,
  },
});
