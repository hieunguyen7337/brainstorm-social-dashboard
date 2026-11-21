import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, platformMeta, space, type as t } from '@/src/theme';
import { LIVE_PLATFORMS, UPCOMING_PLATFORMS } from '@/src/platforms';
import { type Platform } from '@/src/types';
import { Chip, ChipRow, haptic } from '@/src/ui';

import { ACCENT_TEXT } from './logic';

/** Multi-select platform chips with a "Select all" / "Clear" shortcut. The selection always follows `LIVE_PLATFORMS` order. Upcoming platforms are greyed, say "Coming soon" and cannot be selected. */
export function PlatformPicker({
  selected,
  onChange,
}: {
  selected: readonly Platform[];
  onChange: (next: Platform[]) => void;
}) {
  const all = selected.length === LIVE_PLATFORMS.length;

  const toggle = (p: Platform) => {
    const has = selected.includes(p);
    onChange(LIVE_PLATFORMS.filter((x) => (x === p ? !has : selected.includes(x))));
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={t.label}>Platforms</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={all ? 'Clear all platforms' : 'Select all platforms'}
          hitSlop={8}
          onPress={() => {
            haptic.select();
            onChange(all ? [] : [...LIVE_PLATFORMS]);
          }}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>{all ? 'Clear' : 'Select all'}</Text>
        </Pressable>
      </View>
      <ChipRow>
        {LIVE_PLATFORMS.map((p) => (
          <Chip
            key={p}
            platform={p}
            label={platformMeta[p].label}
            selected={selected.includes(p)}
            onPress={() => toggle(p)}
          />
        ))}
        {UPCOMING_PLATFORMS.map((p) => (
          <Chip
            key={p}
            platform={p}
            label={`${platformMeta[p].label} · Coming soon`}
            selected={false}
            disabled
          />
        ))}
      </ChipRow>
      {selected.length === 0 ? <Text style={styles.hint}>Pick at least one platform.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  action: { minHeight: 32, minWidth: 64, alignItems: 'flex-end', justifyContent: 'center' },
  actionText: { fontSize: 13.5, fontWeight: '700', color: ACCENT_TEXT },
  pressed: { opacity: 0.7 },
  hint: { fontSize: 12.5, color: colors.warn },
});
