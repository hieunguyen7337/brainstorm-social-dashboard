import Ionicons from '@expo/vector-icons/Ionicons';
import { Animated, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { MAX_CONTENT_WIDTH } from '@/src/config';
import { colors, space, type as t } from '@/src/theme';
import type { Connection } from '@/src/types';
import { Badge, Button } from '@/src/ui';

import type { Batch } from './logic';
import { PostActions } from './PostActions';
import { PostPage } from './PostPage';
import { ResultPager } from './ResultPager';
import { useEaseIn, useResultState } from './useResultState';

export interface ResultViewProps {
  batch: Batch;
  connections: Connection[] | undefined;
  brandName: string;
  /** Back to the form ("Edit brief" / "New generation"). */
  onBack: () => void;
}

/**
 * The generated posts: platform chips, swipeable editable cards and the actions for the card on screen. The per-post
 * local state (unsaved edits, in-flight work, last error) lives in `useResultState`. Mount it with `key={batch.id}`.
 */
export function ResultView({ batch, connections, brandName, onBack }: ResultViewProps) {
  const { width: windowW } = useWindowDimensions();
  const ease = useEaseIn();
  const r = useResultState({ batch, connections, brandName, onBack });
  const { posts, active, bulk } = r;

  if (!active) return null;

  const wide = Math.min(windowW - 2 * space.lg, MAX_CONTENT_WIDTH) >= 560;

  return (
    <Animated.View style={[styles.root, ease]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={t.h2} accessibilityRole="header">
            {r.title}
          </Text>
          {batch.aiUsed ? (
            <Badge label="Written by Claude" tone="accent" icon="sparkles" />
          ) : (
            <Badge label="Template mode" tone="warn" />
          )}
        </View>
        <Button
          title="Edit brief"
          icon="create-outline"
          variant="ghost"
          small
          disabled={bulk !== null}
          onPress={() => void r.leave()}
        />
      </View>
      {batch.aiUsed ? null : (
        <Text style={[t.small, styles.explain]}>
          {"Claude wasn't available for this batch, so these are smart templates. Edit them freely."}
        </Text>
      )}

      <ResultPager
        posts={posts}
        index={r.activeIndex}
        onIndexChange={r.setIndex}
        dirtyIds={r.dirtyIds}
        renderPage={(p) => <PostPage {...r.pageProps(p)} />}
      />

      <PostActions key={active.id} {...r.actionProps(active)} wide={wide} />

      {r.openCount > 1 ? (
        <Button
          title={bulk ? `Publishing ${Math.min(bulk.done + 1, bulk.total)} of ${bulk.total}...` : `Publish all (${r.openCount})`}
          icon="rocket-outline"
          variant="secondary"
          full
          loading={bulk !== null}
          disabled={r.anyBusy && bulk === null}
          onPress={() => void r.publishAll()}
        />
      ) : null}

      {r.allDone ? <Button title="New generation" icon="sparkles-outline" variant="secondary" full onPress={onBack} /> : null}

      <View style={styles.note}>
        <Ionicons name="link-outline" size={14} color={colors.textMute} />
        <Text style={[t.small, styles.noteText]}>Every post carries a tracked link. Real clicks show up in your funnel.</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.lg },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md },
  headerText: { flex: 1, minWidth: 0, gap: space.sm },
  explain: { color: colors.textMute, marginTop: -space.sm },
  note: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: space.md },
  noteText: { color: colors.textMute, textAlign: 'center', flexShrink: 1 },
});
