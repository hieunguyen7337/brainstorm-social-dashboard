import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, space, trendSourceMeta, type as t, withAlpha } from '@/src/theme';
import type { Trend } from '@/src/types';
import { Button, Card, SectionHeader, Skeleton } from '@/src/ui';

const MAX_TRENDS = 5;

const pctOf = (v: number): number => Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 100);

/** Same hand-off as the Trends tab: Create opens with this trend already chosen. */
const createFrom = (trend: Trend) =>
  router.push({ pathname: '/create', params: { trendId: trend.id, trendTitle: trend.title } });

/**
 * "Outside trends": the five trends that match this brand best (the API ranks them), each with a one-tap
 * "Create from this trend". Failures and empty lists stay inside the card: the rest of the board keeps working.
 */
export function OutsideTrendsCard({
  trends,
  loading,
  error,
  onRetry,
  style,
}: {
  trends: Trend[] | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const rows = (Array.isArray(trends) ? trends : []).slice(0, MAX_TRENDS);

  return (
    <Card style={[styles.card, style]}>
      <SectionHeader
        title="Outside trends"
        subtitle="What people are talking about, matched to you"
        // Room for the floating refresh button that Screen draws over the top right corner of the board.
        style={styles.header}
      />
      {!trends ? (
        error && !loading ? (
          <View style={styles.message}>
            <Ionicons name="cloud-offline-outline" size={18} color={colors.danger} />
            <Text style={[t.dim, styles.messageText]}>Couldn't load trends.</Text>
            <Button title="Retry" variant="secondary" small onPress={onRetry} />
          </View>
        ) : (
          <TrendsSkeleton />
        )
      ) : rows.length === 0 ? (
        <View style={styles.message}>
          <Ionicons name="trending-up-outline" size={18} color={colors.textMute} />
          <Text style={[t.dim, styles.messageText]}>No trends yet. Open Trends to refresh the feeds.</Text>
        </View>
      ) : (
        <View>
          {rows.map((trend, i) => (
            <TrendLine key={trend.id} trend={trend} rank={i + 1} last={i === rows.length - 1} />
          ))}
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="See all trends"
        hitSlop={6}
        onPress={() => router.push('/trends')}
        style={({ pressed }) => [styles.all, pressed && styles.pressed]}
      >
        <Text style={styles.allText}>See all trends</Text>
        <Ionicons name="chevron-forward" size={14} color={colors.accent} />
      </Pressable>
    </Card>
  );
}

function TrendLine({ trend, rank, last }: { trend: Trend; rank: number; last: boolean }) {
  const meta = trendSourceMeta[trend.source] ?? trendSourceMeta.hackernews;
  const match = pctOf(trend.relevance);
  return (
    <View style={[styles.row, !last && styles.divider]}>
      <View style={[styles.rank, { backgroundColor: withAlpha(meta.color, 0.14) }]}>
        <Text style={[styles.rankText, { color: meta.color }]}>{rank}</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>
          {trend.title}
        </Text>
        <View style={styles.meta}>
          <View style={styles.source} accessibilityLabel={`${meta.label}, ${match}% match`} accessible>
            <FontAwesome6 name={meta.icon} size={11} color={meta.color} brand />
            <Text style={styles.match}>{`${match}% match`}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Create from this trend: ${trend.title}`}
            hitSlop={6}
            onPress={() => createFrom(trend)}
            style={({ pressed }) => [styles.create, pressed && styles.pressed]}
          >
            <Ionicons name="sparkles" size={12} color={colors.accent} />
            <Text style={styles.createText} numberOfLines={1}>
              Create from this trend
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function TrendsSkeleton() {
  return (
    <View style={styles.skeleton}>
      {[0, 1, 2, 3, 4].map((i) => (
        <View key={i} style={styles.row}>
          <Skeleton width={24} height={24} rounded={12} />
          <View style={styles.body}>
            <Skeleton width={i % 2 ? '78%' : '92%'} height={13} />
            <Skeleton width="48%" height={11} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  header: { paddingRight: space.lg },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: 10 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rank: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  rankText: { fontSize: 12.5, fontWeight: '800', fontVariant: ['tabular-nums'] },
  body: { flex: 1, minWidth: 0, gap: 5 },
  title: { ...t.body, fontSize: 14, lineHeight: 19, fontWeight: '600' },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.md, rowGap: 4 },
  source: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  match: { color: colors.textDim, fontSize: 12.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  create: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 22 },
  createText: { color: colors.accent, fontSize: 12.5, fontWeight: '700' },
  all: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', gap: 2, minHeight: 28, marginTop: 'auto' },
  allText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.8 },
  message: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.md },
  messageText: { flex: 1 },
  skeleton: { gap: 0 },
});
