import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type as t, withAlpha } from '@/src/theme';
import type { Theme } from '@/src/types';
import { ChipStrip, Skeleton, haptic } from '@/src/ui';

import { ACCENT_TEXT } from './logic';

export interface ThemePickerProps {
  /** Active themes only. */
  themes: Theme[];
  loading: boolean;
  failed: boolean;
  selectedId: string | null;
  /** Single select: tapping the selected theme again passes `null`. */
  onSelect: (id: string | null) => void;
  onRetry: () => void;
}

/** One content pillar as a chip with its colour dot. */
function ThemeChip({ theme, selected, onPress }: { theme: Theme; selected: boolean; onPress: () => void }) {
  const c = theme.color || colors.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Theme ${theme.name}`}
      onPress={() => {
        haptic.select();
        onPress();
      }}
      style={({ pressed }) => [
        styles.chip,
        selected
          ? { backgroundColor: withAlpha(c, 0.18), borderColor: withAlpha(c, 0.75) }
          : { backgroundColor: colors.cardHi, borderColor: colors.border },
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.dot, { backgroundColor: c }]} />
      <Text style={[styles.chipLabel, { color: selected ? colors.text : colors.textDim }]} numberOfLines={1}>
        {theme.name}
      </Text>
    </Pressable>
  );
}

/** Optional content theme: a single-select chip strip of the workspace's active themes. */
export function ThemePicker({ themes, loading, failed, selectedId, onSelect, onRetry }: ThemePickerProps) {
  const selected = themes.find((x) => x.id === selectedId) ?? null;

  let body;
  if (loading) {
    body = (
      <View style={styles.skeletons}>
        {[92, 120, 100].map((w) => (
          <Skeleton key={w} width={w} height={36} rounded={18} />
        ))}
      </View>
    );
  } else if (failed) {
    body = (
      <Pressable accessibilityRole="button" onPress={onRetry} style={styles.hintRow}>
        <Text style={styles.muted}>{"Couldn't load your themes."}</Text>
        <Text style={styles.link}>Tap to retry</Text>
      </Pressable>
    );
  } else if (themes.length === 0) {
    body = (
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Add themes in Settings"
        onPress={() => router.push('/settings')}
        style={styles.hintRow}
      >
        <Text style={styles.muted}>Add themes in Settings</Text>
        <Ionicons name="chevron-forward" size={14} color={colors.textMute} />
      </Pressable>
    );
  } else {
    body = (
      <>
        <ChipStrip>
          {themes.map((th) => (
            <ThemeChip
              key={th.id}
              theme={th}
              selected={th.id === selectedId}
              onPress={() => onSelect(th.id === selectedId ? null : th.id)}
            />
          ))}
        </ChipStrip>
        {selected?.description ? (
          <Text style={[t.small, styles.description]} numberOfLines={2}>
            {selected.description}
          </Text>
        ) : null}
      </>
    );
  }

  return (
    <View style={styles.wrap}>
      <Text style={t.label}>Theme</Text>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  skeletons: { flexDirection: 'row', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    minHeight: 36,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  pressed: { opacity: 0.85 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  chipLabel: { fontSize: 14, fontWeight: '600' },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36 },
  muted: { fontSize: 13.5, color: colors.textMute },
  description: { color: colors.textMute },
  link: { fontSize: 13.5, fontWeight: '700', color: ACCENT_TEXT },
});
