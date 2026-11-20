import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, type MutableRefObject } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { colors, space, type as t } from '@/src/theme';
import type { Connection } from '@/src/types';
import { Button } from '@/src/ui';

import { CardGrid } from './CardGrid';
import { AiBadge } from './AiBadge';
import type { Batch } from './logic';
import { PostCard } from './PostCard';
import { useEaseIn, useResultState } from './useResultState';

export interface ResultGridProps {
  batch: Batch;
  connections: Connection[] | undefined;
  brandName: string;
  /** Back to the placeholder ("Edit brief" / "New generation"). */
  onBack: () => void;
  /** Kept in step with "some card has unsaved edits", so the board can ask before it replaces them. */
  unsavedRef?: MutableRefObject<boolean>;
}

/**
 * The generated posts on the wide board: every platform's card side by side in a 2-column grid instead of the phone's
 * one-page-at-a-time pager. Same state and actions as `ResultView` (see `useResultState`). Mount with `key={batch.id}`.
 */
export function ResultGrid({ batch, connections, brandName, onBack, unsavedRef }: ResultGridProps) {
  const ease = useEaseIn();
  const r = useResultState({ batch, connections, brandName, onBack });
  const { posts, bulk } = r;

  const unsaved = r.dirtyIds.size > 0;
  useEffect(() => {
    if (!unsavedRef) return undefined;
    unsavedRef.current = unsaved;
    return () => {
      unsavedRef.current = false;
    };
  }, [unsaved, unsavedRef]);

  if (posts.length === 0) return null;

  return (
    <Animated.View style={[styles.root, ease]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={t.h2} accessibilityRole="header">
            {r.title}
          </Text>
          <AiBadge aiUsed={batch.aiUsed} />
        </View>
        <View style={styles.headerActions}>
          {r.openCount > 1 ? (
            <Button
              title={bulk ? `Publishing ${Math.min(bulk.done + 1, bulk.total)} of ${bulk.total}...` : `Publish all (${r.openCount})`}
              icon="rocket-outline"
              variant="secondary"
              small
              loading={bulk !== null}
              disabled={r.anyBusy && bulk === null}
              onPress={() => void r.publishAll()}
            />
          ) : null}
          {r.allDone ? <Button title="New generation" icon="sparkles-outline" variant="secondary" small onPress={onBack} /> : null}
          <Button
            title="Edit brief"
            icon="create-outline"
            variant="ghost"
            small
            disabled={bulk !== null}
            onPress={() => void r.leave()}
          />
        </View>
      </View>

      <CardGrid>
        {posts.map((p) => (
          <PostCard key={p.id} page={r.pageProps(p)} actions={r.actionProps(p)} />
        ))}
      </CardGrid>

      <View style={styles.note}>
        <Ionicons name="link-outline" size={14} color={colors.textMute} />
        <Text style={[t.small, styles.noteText]}>Every post carries a tracked link. Real clicks show up in your funnel.</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.lg },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  headerText: { flexGrow: 1, flexBasis: 180, minWidth: 0, gap: space.sm },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: space.sm },
  note: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: space.md },
  noteText: { color: colors.textMute, textAlign: 'center', flexShrink: 1 },
});
