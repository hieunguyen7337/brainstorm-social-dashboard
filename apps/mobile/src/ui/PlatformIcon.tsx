import { FontAwesome6 } from '@expo/vector-icons';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { onPlatformColor, platformMeta, radius, withAlpha } from '@/src/theme';
import type { Platform } from '@/src/types';

/** Brand glyph (Font Awesome 6 brand set) in the platform's colour. */
export function PlatformIcon({ platform, size = 16, color }: { platform: Platform; size?: number; color?: string }) {
  const m = platformMeta[platform];
  return <FontAwesome6 name={m.icon} size={size} color={color ?? m.color} brand />;
}

/** Round tinted badge with the glyph; `solid` fills with the brand colour. */
export function PlatformBadge({
  platform,
  size = 32,
  solid = false,
  style,
}: {
  platform: Platform;
  size?: number;
  solid?: boolean;
  style?: ViewStyle;
}) {
  const m = platformMeta[platform];
  return (
    <View
      style={[
        styles.badge,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: solid ? m.color : withAlpha(m.color, 0.16),
        },
        style,
      ]}
    >
      <PlatformIcon platform={platform} size={Math.round(size * 0.5)} color={solid ? onPlatformColor(platform) : m.color} />
    </View>
  );
}

/** Icon + label, e.g. in a card header. */
export function PlatformLabel({ platform, size = 14 }: { platform: Platform; size?: number }) {
  const m = platformMeta[platform];
  return (
    <View style={styles.row}>
      <PlatformIcon platform={platform} size={size} />
      <Text style={[styles.label, { fontSize: size }]}>{m.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { color: '#f4f6ff', fontWeight: '700' },
});
