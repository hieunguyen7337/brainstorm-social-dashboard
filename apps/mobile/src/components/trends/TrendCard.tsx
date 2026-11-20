import Ionicons from '@expo/vector-icons/Ionicons';
import { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';

import type { Trend } from '@/src/api';
import { colors, space, trendSourceMeta, type as t, withAlpha } from '@/src/theme';
import { Button, Card, IconButton } from '@/src/ui';
import { BuzzBar, RelevanceBar } from './Bars';
import { SourceBadge } from './SourceBadge';
import { HOT_SCORE, buzzWord, clamp01, fitWord, hostOf, safeUrl, toPct } from './trendUtils';

export interface TrendCardProps {
  trend: Trend;
  /** 1-based position inside its source group. */
  rank: number;
  /** Staggered fade-in on the very first load: delay in ms. `null` = appear instantly. Read once, at mount. */
  enterDelay: number | null;
  /** Ease the bars in from empty on mount (first screenful only). */
  animateBars: boolean;
  onCreate: (trend: Trend) => void;
  onOpen: (trend: Trend) => void;
}

/**
 * One trend as a card of the wide 3-column grid. It carries what a phone row shows after expanding: rank, source
 * badge and host, the title, the relevance bar with its plain-words fit, the Buzz meter, and the two actions
 * ("Create from this trend", "Open source"), so nothing needs a tap to open.
 */
export const TrendCard = memo(function TrendCard({
  trend,
  rank,
  enterDelay,
  animateBars,
  onCreate,
  onOpen,
}: TrendCardProps) {
  const meta = trendSourceMeta[trend.source];
  const relevance = clamp01(trend.relevance);
  const buzz = clamp01(trend.score);
  const hot = buzz >= HOT_SCORE;
  const host = hostOf(trend.url);
  const canOpen = safeUrl(trend.url) !== null;
  const pct = toPct(relevance);

  // Entrance: fade + rise, staggered by `enterDelay`; decided once at mount so re-renders never replay it.
  const enter = useRef(enterDelay).current;
  const appear = useRef(new Animated.Value(enter === null ? 1 : 0)).current;
  const rise = useMemo(() => appear.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }), [appear]);
  useEffect(() => {
    if (enter === null) return undefined;
    const anim = Animated.timing(appear, {
      toValue: 1,
      duration: 380,
      delay: enter,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    anim.start();
    return () => anim.stop();
  }, [appear, enter]);
  const barDelay = (enter ?? 0) + 140;

  return (
    <Animated.View style={[styles.cell, { opacity: appear, transform: [{ translateY: rise }] }]}>
      <Card style={styles.card}>
        <View style={styles.top}>
          <View style={[styles.rank, { backgroundColor: withAlpha(meta.color, 0.14) }]}>
            <Text style={[styles.rankText, { color: meta.color }]}>{rank}</Text>
          </View>
          <SourceBadge source={trend.source} size={20} />
          <Text style={styles.host} numberOfLines={1}>
            {host || 'No link'}
          </Text>
          {hot ? <Ionicons name="flame" size={16} color={colors.warn} accessibilityLabel="Hot" /> : null}
          {canOpen ? (
            <IconButton
              icon="open-outline"
              size={16}
              label={`Open source: ${trend.title}`}
              onPress={() => onOpen(trend)}
              style={styles.open}
            />
          ) : null}
        </View>

        <Text style={styles.title} numberOfLines={4}>
          {trend.title}
        </Text>

        <View style={styles.meters}>
          <View style={styles.meter}>
            <View style={styles.meterHead}>
              <Text style={styles.meterLabel} numberOfLines={1}>
                <Text style={styles.meterNum}>{`${pct}%`}</Text>
                {' match'}
              </Text>
              <Text style={styles.meterWord} numberOfLines={1}>
                {fitWord(relevance)}
              </Text>
            </View>
            <View style={styles.barRow}>
              <RelevanceBar value={relevance} animate={animateBars} delay={barDelay} />
            </View>
          </View>

          <View style={styles.buzzRow}>
            <Text style={[styles.meterWord, hot && { color: colors.warn }]} numberOfLines={1}>
              {buzzWord(buzz)}
            </Text>
            <BuzzBar value={buzz} animate={animateBars} delay={barDelay} />
          </View>
        </View>

        <Button
          title="Create from this trend"
          icon="sparkles"
          small
          onPress={() => onCreate(trend)}
          style={styles.create}
        />
      </Card>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  // Fills the grid cell, so the cards of one row share a height and their "Create" buttons line up.
  cell: { flex: 1, minWidth: 0 },
  card: { flex: 1, gap: space.md },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  rank: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rankText: { fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  host: { flex: 1, minWidth: 0, fontSize: 12.5, color: colors.textMute },
  open: { width: 30, height: 30, borderRadius: 15 },
  title: { ...t.body, fontWeight: '600', letterSpacing: -0.1 },
  // Pushes the meters and the button to the bottom of the card whatever the title length.
  meters: { gap: 10, marginTop: 'auto' },
  meter: { gap: 6 },
  meterHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  meterLabel: { flexShrink: 0, fontSize: 12.5, color: colors.textDim, fontVariant: ['tabular-nums'] },
  meterNum: { color: colors.text, fontWeight: '800' },
  meterWord: { flexShrink: 1, fontSize: 12.5, fontWeight: '600', color: colors.textDim },
  barRow: { flexDirection: 'row', alignItems: 'center' },
  buzzRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  create: { alignSelf: 'stretch' },
});
