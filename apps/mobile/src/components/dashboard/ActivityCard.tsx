import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';

import { colors, space, type as t, withAlpha } from '@/src/theme';
import type { ActivityItem } from '@/src/types';
import { Badge, Button, Card, PlatformIcon, SectionHeader, Skeleton } from '@/src/ui';
import { LiveTag } from './live';
import { activityMeta, agoLabel, isPlatform, newestFirst } from './model';

const NATIVE = Platform.OS !== 'web';
const MAX_ROWS = 12;
const ROW_PAD = space.sm;
const ICON = 32;

/**
 * Newest-first event feed. Rows with `real: true` (a visitor really clicked or converted) get a green tint, a green
 * left edge and a REAL badge so a judge's own click stands out. New rows slide in once; polls never replay anything.
 */
export function ActivityCard({
  items,
  loading,
  error,
  onRetry,
}: {
  items: ActivityItem[] | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <Card style={styles.card}>
      <SectionHeader title="Live activity" subtitle="Updates every few seconds" right={<LiveTag />} />
      {!items ? (
        error && !loading ? (
          <View style={styles.errorRow}>
            <Ionicons name="cloud-offline-outline" size={18} color={colors.danger} />
            <Text style={[t.dim, styles.errorText]}>Couldn't load activity.</Text>
            <Button title="Retry" variant="secondary" small onPress={onRetry} />
          </View>
        ) : (
          <ActivitySkeleton />
        )
      ) : items.length === 0 ? (
        <Text style={[t.dim, styles.empty]}>
          No activity yet. Publish a post and its views, clicks and onboards will stream in here.
        </Text>
      ) : (
        <ActivityList items={items} />
      )}
    </Card>
  );
}

/** Ids that were not on screen at the previous commit (empty on the very first render). */
function useFreshIds(rows: ActivityItem[]): Set<string> {
  const known = useRef<Set<string> | null>(null);
  const fresh = new Set<string>();
  const prior = known.current;
  if (prior) for (const r of rows) if (!prior.has(r.id)) fresh.add(r.id);
  useEffect(() => {
    known.current = new Set(rows.map((r) => r.id));
  });
  return fresh;
}

function ActivityList({ items }: { items: ActivityItem[] }) {
  const rows = newestFirst(items).slice(0, MAX_ROWS);
  const fresh = useFreshIds(rows);
  return (
    <View style={styles.list}>
      {rows.map((item, i) => (
        <View key={item.id}>
          <ActivityRow item={item} fresh={fresh.has(item.id)} />
          {i < rows.length - 1 ? <View style={styles.divider} /> : null}
        </View>
      ))}
    </View>
  );
}

function ActivityRow({ item, fresh }: { item: ActivityItem; fresh: boolean }) {
  const meta = activityMeta(item.type);

  // Only a row that was new when it mounted animates in; later renders (fresh flips to false) leave it alone.
  const wasFresh = useRef(fresh);
  const enter = useRef(new Animated.Value(fresh ? 0 : 1)).current;
  useEffect(() => {
    if (!wasFresh.current) return undefined;
    const anim = Animated.timing(enter, {
      toValue: 1,
      duration: 480,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: NATIVE,
    });
    anim.start();
    return () => anim.stop();
  }, [enter]);

  return (
    <Animated.View
      style={[
        styles.row,
        item.real && styles.rowReal,
        {
          opacity: enter,
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }],
        },
      ]}
    >
      <View style={[styles.icon, { backgroundColor: withAlpha(meta.color, 0.16) }]}>
        <Ionicons name={meta.icon} size={meta.size} color={meta.color} />
      </View>
      <View style={styles.body}>
        <Text style={styles.detail} numberOfLines={2}>
          {item.detail || item.type}
        </Text>
        <View style={styles.meta}>
          {isPlatform(item.platform) ? <PlatformIcon platform={item.platform} size={12} /> : null}
          <Text style={t.small}>{agoLabel(item.ts)}</Text>
          {item.real ? <Badge label="REAL" tone="success" icon="person" /> : null}
        </View>
      </View>
    </Animated.View>
  );
}

function ActivitySkeleton() {
  return (
    <View style={styles.skeletonList}>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={styles.skeletonRow}>
          <Skeleton width={ICON} height={ICON} rounded={ICON / 2} />
          <View style={styles.skeletonText}>
            <Skeleton width={i % 2 ? '85%' : '95%'} height={13} />
            <Skeleton width="38%" height={11} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  // Rows pad themselves by ROW_PAD so a tinted (real) row has room; pull the list back so text still lines up.
  list: { marginHorizontal: -ROW_PAD },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: 10,
    paddingHorizontal: ROW_PAD,
  },
  rowReal: {
    backgroundColor: withAlpha(colors.success, 0.09),
    borderLeftWidth: 3,
    borderLeftColor: colors.success,
    borderRadius: 10,
    paddingLeft: ROW_PAD - 3,
  },
  divider: { height: 1, backgroundColor: colors.border, marginLeft: ROW_PAD + ICON + space.md, marginRight: ROW_PAD },
  icon: { width: ICON, height: ICON, borderRadius: ICON / 2, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: 4 },
  detail: { color: colors.text, fontSize: 14, lineHeight: 19, fontWeight: '500' },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  empty: { textAlign: 'center', paddingVertical: space.xl },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  errorText: { flex: 1 },
  skeletonList: { gap: space.lg, paddingVertical: space.xs },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  skeletonText: { flex: 1, gap: 6 },
});
