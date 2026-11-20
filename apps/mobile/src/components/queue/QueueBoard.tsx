import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';

import type { Platform, Post } from '@/src/api';
import { Col, Grid } from '@/src/layout';
import { colors, radius, space, type as t, withAlpha } from '@/src/theme';
import { ErrorState } from '@/src/ui';
import { EmptyQueue } from './EmptyQueue';
import { FadeIn } from './FadeIn';
import { LiveDot } from './LiveDot';
import { PostCard, type PostCardProps } from './PostCard';
import { PostCardSkeleton } from './PostCardSkeleton';
import type { Account, BusyKind, QueueLists, QueueTab } from './queueModel';
import { QueueStatusRow, type BulkProgress } from './QueueStatusRow';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** Below this column width the cards switch to their compact layout (counters 2 x 2, link buttons on their own line). */
const COMPACT_BELOW = 340;
/** Room taken above the lanes (title, subtitle, page padding, lane header) when sizing a lane's own scroll area. */
const CHROME_HEIGHT = 200;
const MIN_LANE_HEIGHT = 360;

/** The statuses and their order, as in the phone's segmented control. */
const LANES: readonly { tab: QueueTab; label: string; icon: IconName; color: string }[] = [
  { tab: 'drafts', label: 'Drafts', icon: 'create-outline', color: colors.accent },
  { tab: 'scheduled', label: 'Scheduled', icon: 'time-outline', color: colors.info },
  { tab: 'published', label: 'Published', icon: 'checkmark-circle', color: colors.success },
];

export interface QueueBoardProps {
  /** Undefined until the first load has answered. */
  lists: QueueLists | undefined;
  /** The first load failed (nothing to show): message for the blocking error state. */
  loadError: string | null;
  onRetry: () => void;
  /** A poll is failing while the old data stays on screen. */
  reconnecting: boolean;
  focused: boolean;
  bulk: BulkProgress | null;
  onPublishAll: () => void;
  busy: Record<string, BusyKind>;
  accounts: Partial<Record<Platform, Account>>;
  /** Staggered fade-in for the cards of the very first load only. */
  intro: boolean;
  /** Everything a card needs besides the post itself. */
  card: Omit<PostCardProps, 'post' | 'busy' | 'account' | 'compact'>;
  /** The lane a programmatic switch (after Publish, the `tab` route param) points at: it scrolls back to the top. */
  activeTab: QueueTab;
  scrollEpoch: number;
  onCreate: () => void;
  onGoDrafts: () => void;
}

/**
 * Wide (desktop) Queue: Drafts | Scheduled | Published side by side. Every lane has a header with its count, its
 * own vertical scroll and the same cards, polling and actions as the phone list; nothing here owns data.
 */
export function QueueBoard(props: QueueBoardProps) {
  const { lists, loadError, onRetry, reconnecting } = props;

  if (!lists && loadError !== null) {
    return <ErrorState title="Couldn't load your queue" message={loadError} onRetry={onRetry} />;
  }

  return (
    <View style={styles.board}>
      {reconnecting ? (
        <View style={styles.reconnecting}>
          <LiveDot live={false} />
          <Text style={styles.reconnectingText}>Reconnecting...</Text>
        </View>
      ) : null}
      <Grid testID="queue-board">
        {LANES.map((lane) => (
          <Col key={lane.tab} span={4} testID={`queue-col-${lane.tab}`}>
            <Lane {...props} {...lane} posts={lists?.[lane.tab]} />
          </Col>
        ))}
      </Grid>
    </View>
  );
}

function Lane({
  tab,
  label,
  icon,
  color,
  posts,
  lists,
  focused,
  reconnecting,
  bulk,
  onPublishAll,
  busy,
  accounts,
  intro,
  card,
  activeTab,
  scrollEpoch,
  onCreate,
  onGoDrafts,
}: QueueBoardProps & { tab: QueueTab; label: string; icon: IconName; color: string; posts: Post[] | undefined }) {
  const { height } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const compact = width > 0 && width < COMPACT_BELOW;
  const scroller = useRef<ScrollView>(null);

  // A programmatic switch (Publish, `tab` route param) lands on the top of its lane, where the newest post is.
  useEffect(() => {
    if (activeTab === tab) scroller.current?.scrollTo({ y: 0, animated: true });
  }, [activeTab, tab, scrollEpoch]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const maxHeight = Math.max(MIN_LANE_HEIGHT, height - CHROME_HEIGHT);

  let body;
  if (!posts) {
    body = (
      <>
        <PostCardSkeleton />
        <PostCardSkeleton />
      </>
    );
  } else if (posts.length === 0) {
    body = (
      <View style={styles.empty}>
        <EmptyQueue tab={tab} hasDrafts={(lists?.drafts.length ?? 0) > 0} onCreate={onCreate} onGoDrafts={onGoDrafts} />
      </View>
    );
  } else {
    body = posts.map((post, i) => (
      <FadeIn key={post.id} index={i} animate={intro}>
        <PostCard {...card} post={post} busy={busy[post.id]} account={accounts[post.platform]} compact={compact} />
      </FadeIn>
    ));
  }

  return (
    <View style={styles.lane} onLayout={onLayout}>
      <View style={[styles.laneHeader, { borderBottomColor: withAlpha(color, 0.55) }]}>
        <View style={[styles.laneIcon, { backgroundColor: withAlpha(color, 0.16) }]}>
          <Ionicons name={icon} size={16} color={color} />
        </View>
        <Text style={[t.h3, styles.laneTitle]} numberOfLines={1} accessibilityRole="header">
          {label}
        </Text>
        {posts ? (
          <View style={[styles.count, { backgroundColor: withAlpha(color, 0.16) }]}>
            <Text style={[styles.countText, { color }]} accessibilityLabel={`${posts.length} ${label}`}>
              {posts.length}
            </Text>
          </View>
        ) : null}
        <View style={styles.laneEnd}>
          {posts ? (
            <QueueStatusRow
              compact
              tight={compact}
              tab={tab}
              hasItems={posts.length > 0}
              focused={focused}
              reconnecting={reconnecting}
              draftCount={lists?.drafts.length ?? 0}
              bulk={bulk}
              onPublishAll={onPublishAll}
            />
          ) : null}
        </View>
      </View>
      <ScrollView
        ref={scroller}
        style={{ maxHeight }}
        contentContainerStyle={styles.laneList}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {body}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  board: { width: '100%', gap: space.md },
  reconnecting: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  reconnectingText: { fontSize: 13, fontWeight: '600', color: colors.textMute },
  lane: { flex: 1, minWidth: 0, gap: space.md },
  laneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 48,
    paddingHorizontal: 2,
    paddingBottom: space.sm,
    borderBottomWidth: 2,
  },
  laneIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  laneTitle: { flexShrink: 1, minWidth: 0 },
  count: { minWidth: 24, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, alignItems: 'center' },
  countText: { fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  laneEnd: { flex: 1, minWidth: 0, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
  laneList: { gap: space.lg, paddingBottom: space.xs },
  empty: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: radius.md,
  },
});
