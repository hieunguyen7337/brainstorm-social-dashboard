import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, platformMeta, radius, withAlpha } from '@/src/theme';
import type { Post } from '@/src/types';
import { PlatformIcon, haptic } from '@/src/ui';

/** Tiny state glyph at the end of a tab: published, scheduled, failed, or "has unsaved edits". */
function Mark({ post, dirty }: { post: Post; dirty: boolean }) {
  if (post.status === 'published') return <Ionicons name="checkmark-circle" size={15} color={colors.success} />;
  if (post.status === 'scheduled') return <Ionicons name="time" size={15} color={colors.info} />;
  if (post.status === 'failed') return <Ionicons name="alert-circle" size={15} color={colors.danger} />;
  if (dirty) return <View style={styles.dirtyDot} />;
  return null;
}

/**
 * One chip per generated post (brand glyph + label + a state mark). The strip scrolls itself so the selected chip
 * stays in view while the cards are swiped.
 */
export function PlatformTabs({
  posts,
  index,
  dirtyIds,
  onSelect,
}: {
  posts: readonly Post[];
  index: number;
  dirtyIds: ReadonlySet<string>;
  onSelect: (index: number) => void;
}) {
  const scroller = useRef<ScrollView>(null);
  const spots = useRef<Record<string, { x: number; w: number }>>({});
  const [stripW, setStripW] = useState(0);
  const activeId = posts[index]?.id;

  useEffect(() => {
    const spot = activeId ? spots.current[activeId] : undefined;
    if (!spot || stripW <= 0) return;
    scroller.current?.scrollTo({ x: Math.max(0, spot.x + spot.w / 2 - stripW / 2), animated: true });
  }, [activeId, stripW]);

  return (
    <ScrollView
      ref={scroller}
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      keyboardShouldPersistTaps="handled"
      onLayout={(e) => setStripW(e.nativeEvent.layout.width)}
      contentContainerStyle={styles.strip}
    >
      {posts.map((p, i) => {
        const active = i === index;
        const meta = platformMeta[p.platform];
        return (
          <Pressable
            key={p.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${meta.label} post`}
            onLayout={(e) => {
              spots.current[p.id] = { x: e.nativeEvent.layout.x, w: e.nativeEvent.layout.width };
            }}
            onPress={() => {
              haptic.select();
              onSelect(i);
            }}
            style={({ pressed }) => [
              styles.tab,
              active
                ? { backgroundColor: withAlpha(meta.color, 0.18), borderColor: withAlpha(meta.color, 0.75) }
                : { backgroundColor: colors.cardHi, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <PlatformIcon platform={p.platform} size={14} color={active ? meta.color : colors.textDim} />
            <Text style={[styles.label, { color: active ? colors.text : colors.textDim }]} numberOfLines={1}>
              {meta.label}
            </Text>
            <Mark post={p} dirty={dirtyIds.has(p.id)} />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { gap: 8, paddingVertical: 2, paddingRight: 8 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    minHeight: 40,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  pressed: { opacity: 0.85 },
  label: { fontSize: 14, fontWeight: '600' },
  dirtyDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent2 },
});
