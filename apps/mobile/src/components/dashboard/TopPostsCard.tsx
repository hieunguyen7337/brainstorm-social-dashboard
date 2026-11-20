import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { fmtCompact, truncate } from '@/src/format';
import { colors, space, type as t } from '@/src/theme';
import type { Post } from '@/src/types';
import { Button, Card, EmptyState, PlatformBadge, SectionHeader } from '@/src/ui';
import { firstLine, isPlatform, type IconName } from './model';

const MAX_POSTS = 5;

const openPublished = () => router.push({ pathname: '/queue', params: { tab: 'published' } });

/** Best performing published posts. Tapping a row opens the queue on its Published tab. */
export function TopPostsCard({ posts, style }: { posts: Post[]; style?: StyleProp<ViewStyle> }) {
  const rows = posts.filter((p) => isPlatform(p.platform)).slice(0, MAX_POSTS);

  return (
    <Card style={[styles.card, style]}>
      <SectionHeader
        title="Top posts"
        subtitle="Your best performers"
        right={
          rows.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="View all published posts"
              hitSlop={8}
              onPress={openPublished}
              style={({ pressed }) => [styles.viewAll, pressed && styles.pressed]}
            >
              <Text style={styles.viewAllText}>View all</Text>
              <Ionicons name="chevron-forward" size={14} color={colors.accent} />
            </Pressable>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <EmptyState
          icon="rocket-outline"
          title="No published posts yet"
          message="Publish a post and your best performers will rank here."
          action={<Button title="Create a post" small icon="add" onPress={() => router.push('/create')} />}
        />
      ) : (
        <View>
          {rows.map((post, i) => (
            <PostRow key={post.id} post={post} rank={i + 1} last={i === rows.length - 1} />
          ))}
        </View>
      )}
    </Card>
  );
}

function PostRow({ post, rank, last }: { post: Post; rank: number; last: boolean }) {
  const text = truncate(firstLine(post.content), 140);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        `Number ${rank}: ${text}. ${fmtCompact(post.views)} views, ${fmtCompact(post.engagements)} engagements` +
        (post.clicks > 0 ? `, ${fmtCompact(post.clicks)} clicks` : '') +
        (post.conversions > 0 ? `, ${fmtCompact(post.conversions)} conversions` : '')
      }
      onPress={openPublished}
      style={({ pressed }) => [styles.row, !last && styles.rowDivider, pressed && styles.pressed]}
    >
      <Text style={styles.rank}>{rank}</Text>
      <PlatformBadge platform={post.platform} size={36} />
      <View style={styles.body}>
        <Text style={styles.text} numberOfLines={2}>
          {text}
        </Text>
        <View style={styles.stats}>
          {/* Same icons and colours as the KPI tiles: views, engagements, then clicks and conversions once any exist. */}
          <Metric icon="eye" color={colors.accent} text={fmtCompact(post.views)} />
          <Metric icon="heart" color={colors.accent2} text={fmtCompact(post.engagements)} />
          {post.clicks > 0 ? <Metric icon="finger-print" color={colors.info} text={fmtCompact(post.clicks)} /> : null}
          {post.conversions > 0 ? <Metric icon="checkmark-circle" color={colors.success} text={fmtCompact(post.conversions)} /> : null}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textMute} />
    </Pressable>
  );
}

function Metric({ icon, color, text }: { icon: IconName; color: string; text: string }) {
  return (
    <View style={styles.metric}>
      <Ionicons name={icon} size={14} color={color} />
      <Text style={styles.metricText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  viewAll: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 32 },
  viewAllText: { color: colors.accent, fontSize: 13.5, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, minHeight: 64 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  pressed: { opacity: 0.85 },
  rank: { width: 18, textAlign: 'center', color: colors.textMute, fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  body: { flex: 1, minWidth: 0, gap: 6 },
  text: { ...t.body, fontSize: 14.5, lineHeight: 20, fontWeight: '600' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.md, rowGap: 4 },
  metric: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metricText: { color: colors.textDim, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
