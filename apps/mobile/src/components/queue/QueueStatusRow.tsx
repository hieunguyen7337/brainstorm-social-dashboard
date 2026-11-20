import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { POLL_MS } from '@/src/config';
import { colors, type as t } from '@/src/theme';
import { Button } from '@/src/ui';
import { LiveDot } from './LiveDot';
import { plural, type QueueTab } from './queueModel';

export interface BulkProgress {
  current: number;
  total: number;
}

/**
 * The slim row under the segmented control:
 * - Published: a pulsing "Live" dot while the screen is focused (the counters below tick every poll),
 * - Drafts (2 or more): "Publish all drafts" with its "Publishing 3/6" progress,
 * - any tab: a muted "Reconnecting..." while a poll is failing (the data on screen stays).
 */
export function QueueStatusRow({
  tab,
  hasItems,
  focused,
  reconnecting,
  draftCount,
  bulk,
  onPublishAll,
  compact = false,
}: {
  tab: QueueTab;
  hasItems: boolean;
  focused: boolean;
  reconnecting: boolean;
  draftCount: number;
  bulk: BulkProgress | null;
  onPublishAll: () => void;
  /**
   * Wide kanban column header: just the inline control (a short "Publish all" button, or the "Live" dot), no
   * row and no sentence. `reconnecting` is the board's own line there.
   */
  compact?: boolean;
}) {
  const showLive = tab === 'published' && hasItems;
  const showBulk = tab === 'drafts' && (draftCount >= 2 || bulk !== null);
  if (compact) {
    if (showBulk) {
      return (
        <Button
          title={bulk ? `Publishing ${bulk.current}/${bulk.total}` : 'Publish all'}
          accessibilityLabel={bulk ? undefined : 'Publish all drafts'}
          icon="rocket-outline"
          small
          loading={bulk !== null}
          onPress={onPublishAll}
        />
      );
    }
    if (showLive && !reconnecting) {
      return (
        <View style={styles.left}>
          <LiveDot live={focused} />
          <Text style={styles.live}>Live</Text>
        </View>
      );
    }
    return null;
  }
  if (!showLive && !showBulk && !reconnecting) return null;

  let left: ReactNode = null;
  if (reconnecting) {
    left = (
      <View style={styles.left}>
        <LiveDot live={false} />
        <Text style={styles.muted}>Reconnecting...</Text>
      </View>
    );
  } else if (showLive) {
    left = (
      <View style={styles.left}>
        <LiveDot live={focused} />
        <Text style={styles.live}>Live</Text>
        <Text style={t.small} numberOfLines={1}>
          {`Updates every ${Math.round(POLL_MS / 1000)}s`}
        </Text>
      </View>
    );
  } else if (showBulk) {
    left = <Text style={t.dim}>{`${plural(draftCount, 'draft')} ${bulk ? 'left' : 'ready'}`}</Text>;
  }

  return (
    <View style={styles.row}>
      <View style={styles.leftWrap}>{left}</View>
      {showBulk ? (
        <Button
          title={bulk ? `Publishing ${bulk.current}/${bulk.total}` : 'Publish all drafts'}
          icon="rocket-outline"
          small
          loading={bulk !== null}
          onPress={onPublishAll}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 36 },
  leftWrap: { flex: 1, minWidth: 0 },
  left: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  live: { fontSize: 12.5, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.success },
  muted: { fontSize: 13, fontWeight: '600', color: colors.textMute },
});
