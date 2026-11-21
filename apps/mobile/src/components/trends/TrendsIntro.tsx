import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { TrendsStatus } from '@/src/api';
import { colors, gradient, space, type as t, withAlpha } from '@/src/theme';
import { Button, Card } from '@/src/ui';
import { agoFromMs, safeAgo, sourceFailureNote } from './trendUtils';

/** Older than this and the status dot turns amber (the server re-pulls feeds every ~15 minutes). */
const STALE_MS = 30 * 60_000;

/** Current time, re-read every `intervalMs` while the screen is focused (only the component that calls it re-renders). */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
      const id = setInterval(() => setNow(Date.now()), intervalMs);
      return () => clearInterval(id);
    }, [intervalMs]),
  );
  return now;
}

/** "Fetched 3m ago" with a status dot, or "Refreshing feeds…" while a forced refresh runs. */
function UpdatedLine({ updatedAt, now, refreshing }: { updatedAt: number | null; now: number; refreshing: boolean }) {
  const stale = updatedAt !== null && now - updatedAt > STALE_MS;
  const dot = refreshing ? colors.accent : stale ? colors.warn : colors.success;
  const text = refreshing ? 'Refreshing feeds…' : updatedAt === null ? 'Trends loaded' : `Fetched ${agoFromMs(updatedAt, now)}`;
  return (
    <View style={styles.status}>
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <Text style={[t.small, styles.statusText]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

export interface TrendsIntroProps {
  /** Oldest `fetched_at` across the trends on screen (epoch ms); null when unknown. */
  updatedAt: number | null;
  /** The list is on screen: show the "updated" line and the Refresh button. */
  ready: boolean;
  /** A forced refresh is in flight. */
  refreshing: boolean;
  /** The latest background load failed while an older list is still showing. */
  offline: boolean;
  /** GET /api/trends/status; null when unknown (old server, or the call failed). */
  status: TrendsStatus | null;
  onRefresh: () => void;
  /** Wide layout: the copy on the left, freshness and Refresh on the right, in one row. */
  inline?: boolean;
}

/** Short intro, freshness and a Refresh button that forces the server to re-pull the feeds. */
export function TrendsIntro({
  updatedAt,
  ready,
  refreshing,
  offline,
  status,
  onRefresh,
  inline = false,
}: TrendsIntroProps) {
  const now = useNow(30_000);
  const failed = Array.isArray(status?.sources) ? status.sources.filter((s) => s && s.ok === false) : [];

  return (
    <Card style={[styles.card, inline && styles.cardInline]}>
      <View style={[styles.top, inline && styles.topInline]}>
        <LinearGradient colors={gradient.colors} start={gradient.start} end={gradient.end} style={styles.icon}>
          <Ionicons name="trending-up" size={20} color={colors.white} />
        </LinearGradient>
        <Text style={[t.dim, styles.copy]}>
          <Text style={styles.lead}>Real feeds, refreshed every few minutes.</Text>
          {' Tap a trend to turn it into posts.'}
        </Text>
      </View>

      {ready ? (
        <View style={[styles.bottom, inline && styles.bottomInline]}>
          <UpdatedLine updatedAt={updatedAt} now={now} refreshing={refreshing} />
          <Button
            title={refreshing ? 'Refreshing' : 'Refresh'}
            icon="refresh"
            variant="secondary"
            small
            loading={refreshing}
            onPress={onRefresh}
            style={styles.refresh}
          />
        </View>
      ) : null}

      {failed.map((entry) => (
        <View key={entry.source} style={styles.failure}>
          <Ionicons name="alert-circle-outline" size={15} color={colors.warn} />
          <Text style={[t.small, styles.offlineText]}>
            {sourceFailureNote(entry, entry.count > 0 ? safeAgo(entry.fetched_at, now) || null : null)}
          </Text>
        </View>
      ))}

      {offline ? (
        <View style={styles.offline}>
          <Ionicons name="cloud-offline-outline" size={15} color={colors.warn} />
          <Text style={[t.small, styles.offlineText]}>{"Can't reach the server. Showing the last trends we loaded."}</Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  cardInline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' },
  topInline: { flexGrow: 1, flexBasis: 320, flexShrink: 1 },
  bottomInline: { flexGrow: 0, flexShrink: 0, paddingTop: 0, borderTopWidth: 0, gap: space.lg },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, minWidth: 0 },
  lead: { color: colors.text, fontWeight: '700' },
  bottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  status: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { flexShrink: 1 },
  // 36px visible button inside a 40px touch target.
  refresh: { minHeight: 40, justifyContent: 'center' },
  offline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: space.sm + 2,
    borderRadius: 10,
    backgroundColor: withAlpha(colors.warn, 0.1),
  },
  offlineText: { flex: 1, minWidth: 0, color: colors.textDim },
  failure: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: space.sm + 2,
    borderRadius: 10,
    backgroundColor: withAlpha(colors.warn, 0.1),
  },
});
