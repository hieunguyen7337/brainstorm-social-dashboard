import Ionicons from '@expo/vector-icons/Ionicons';
import { memo, useEffect, useMemo, useRef, type ComponentProps, type ReactNode } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Trend } from '@/src/api';
import { colors, space, trendSourceMeta, type as t, withAlpha } from '@/src/theme';
import { Button, Card } from '@/src/ui';
import { BuzzBar, RelevanceBar } from './Bars';
import { SourceBadge } from './SourceBadge';
import {
  HOT_SCORE,
  SOURCE_SHORT,
  buzzWord,
  clamp01,
  fitWord,
  hostOf,
  safeAgo,
  safeUrl,
  toPct,
} from './trendUtils';

type IconName = ComponentProps<typeof Ionicons>['name'];

export interface TrendRowProps {
  trend: Trend;
  /** 1-based position inside its source group. */
  rank: number;
  /** Brand name used in the explanation copy. */
  brand: string;
  expanded: boolean;
  /** Staggered fade-in on the very first load: delay in ms. `null` = appear instantly. Read once, at mount. */
  enterDelay: number | null;
  /** Ease the bars in from empty on mount (only the first screenful, which keeps long lists cheap). */
  animateBars: boolean;
  onToggle: (id: string) => void;
  onCreate: (trend: Trend) => void;
  onOpen: (trend: Trend) => void;
}

/**
 * One trend: rank, title, relevance bar ("92% match", flame when hot), source badge + host and a Buzz meter.
 * Tapping the header expands the row in place: full title, why it ranks, "Create from this trend" and "Open source".
 */
export const TrendRow = memo(function TrendRow({
  trend,
  rank,
  brand,
  expanded,
  enterDelay,
  animateBars,
  onToggle,
  onCreate,
  onOpen,
}: TrendRowProps) {
  const meta = trendSourceMeta[trend.source];
  const relevance = clamp01(trend.relevance);
  const buzz = clamp01(trend.score);
  const hot = buzz >= HOT_SCORE;
  const host = hostOf(trend.url);
  const canOpen = safeUrl(trend.url) !== null;

  // Entrance: fade + rise, staggered by `enterDelay`. Decided once at mount so later re-renders never replay it.
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

  // Bars start once the row has faded in.
  const barDelay = (enter ?? 0) + 140;
  const pct = toPct(relevance);

  return (
    <Animated.View style={{ opacity: appear, transform: [{ translateY: rise }] }}>
      <Card padded={false} testID="trend-item" style={expanded ? { borderColor: withAlpha(meta.color, 0.55) } : undefined}>
        <Pressable
          onPress={() => onToggle(trend.id)}
          accessibilityRole="button"
          aria-expanded={expanded}
          accessibilityLabel={`${rank}. ${trend.title}. ${pct}% match${hot ? ', hot' : ''}. ${meta.label}.`}
          accessibilityHint={expanded ? 'Hides the details' : 'Shows the details and what you can do with it'}
          style={({ pressed }) => [styles.head, pressed && styles.headPressed]}
        >
          <View style={[styles.rank, { backgroundColor: withAlpha(meta.color, 0.14) }]}>
            <Text style={[styles.rankText, { color: meta.color }]}>{rank}</Text>
          </View>

          <View style={styles.body}>
            <View style={styles.titleRow}>
              <Text style={styles.title} numberOfLines={expanded ? undefined : 3}>
                {trend.title}
              </Text>
              <Ionicons
                name={expanded ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={colors.textMute}
                style={styles.chevron}
              />
            </View>

            <View style={styles.matchRow}>
              <RelevanceBar value={relevance} animate={animateBars} delay={barDelay} />
              <Text style={styles.matchLabel} numberOfLines={1}>
                <Text style={styles.matchNum}>{`${pct}%`}</Text>
                {' match'}
              </Text>
              <View style={styles.flameSlot}>
                {hot ? <Ionicons name="flame" size={16} color={colors.warn} /> : null}
              </View>
            </View>

            <View style={styles.metaRow}>
              <View style={styles.source}>
                <SourceBadge source={trend.source} size={20} />
                <Text style={styles.host} numberOfLines={1}>
                  {host || 'No link'}
                </Text>
              </View>
              <BuzzBar value={buzz} animate={animateBars} delay={barDelay} />
            </View>
          </View>
        </Pressable>

        {expanded ? (
          <Details
            trend={trend}
            brand={brand}
            host={host}
            hot={hot}
            relevance={relevance}
            buzz={buzz}
            canOpen={canOpen}
            onCreate={onCreate}
            onOpen={onOpen}
          />
        ) : null}
      </Card>
    </Animated.View>
  );
});

interface DetailsProps {
  trend: Trend;
  brand: string;
  host: string;
  hot: boolean;
  relevance: number;
  buzz: number;
  canOpen: boolean;
  onCreate: (trend: Trend) => void;
  onOpen: (trend: Trend) => void;
}

/** The expanded half of a row. Mounts when the row opens and fades in. */
function Details({ trend, brand, host, hot, relevance, buzz, canOpen, onCreate, onOpen }: DetailsProps) {
  const meta = trendSourceMeta[trend.source];
  const short = SOURCE_SHORT[trend.source];
  const ago = safeAgo(trend.fetched_at);

  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(appear, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== 'web',
    });
    anim.start();
    return () => anim.stop();
  }, [appear]);

  return (
    <Animated.View style={[styles.details, { opacity: appear }]}>
      <View style={styles.sourceLine}>
        <SourceBadge source={trend.source} size={28} />
        <View style={styles.sourceText}>
          <Text style={[t.h3, styles.sourceName]} numberOfLines={1}>
            {meta.label}
          </Text>
          {/* Host shrinks first on narrow screens; the age is never cut. */}
          <View style={styles.subRow}>
            <Text style={[t.small, styles.subHost]} numberOfLines={1}>
              {host || 'No source link'}
            </Text>
            {ago ? <Text style={[t.small, styles.subAge]}>{` · fetched ${ago}`}</Text> : null}
          </View>
        </View>
      </View>

      <Explain icon="sparkles" tint={colors.accent} head={`${toPct(relevance)}% match`} tag={fitWord(relevance)}>
        {`How closely this topic fits ${brand}, scored against your brand profile.`}
      </Explain>
      <Explain
        icon="flame"
        tint={colors.warn}
        head={`${toPct(buzz)}% buzz`}
        tag={buzzWord(buzz)}
        tagColor={hot ? colors.warn : undefined}
      >
        {`How much attention it is getting on ${short} right now, scaled from 0 to 100.`}
      </Explain>

      <View style={styles.actions}>
        <Button title="Create from this trend" icon="sparkles" onPress={() => onCreate(trend)} style={styles.primary} />
        {canOpen ? (
          <Button
            title="Open source"
            icon="open-outline"
            variant="secondary"
            onPress={() => onOpen(trend)}
            style={styles.secondary}
          />
        ) : null}
      </View>
    </Animated.View>
  );
}

function Explain({
  icon,
  tint,
  head,
  tag,
  tagColor,
  children,
}: {
  icon: IconName;
  tint: string;
  head: string;
  tag: string;
  /** Colour for the plain-words tag (default: dim). */
  tagColor?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.explain}>
      <View style={[styles.explainIcon, { backgroundColor: withAlpha(tint, 0.14) }]}>
        <Ionicons name={icon} size={15} color={tint} />
      </View>
      <View style={styles.explainText}>
        <Text style={styles.explainHead}>
          {head}
          <Text style={[styles.explainTag, tagColor ? { color: tagColor } : null]}>{`  ${tag}`}</Text>
        </Text>
        <Text style={t.small}>{children}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, padding: space.lg },
  headPressed: { backgroundColor: withAlpha(colors.white, 0.04) },
  // 26px badge centred on the first 22px title line.
  rank: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginTop: -2 },
  rankText: { fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  body: { flex: 1, minWidth: 0, gap: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  title: { ...t.body, flex: 1, minWidth: 0, fontWeight: '600', letterSpacing: -0.1 },
  chevron: { marginTop: 2 },
  // Capped so the bar does not stretch across a 720px desktop column; the fixed label width keeps bars comparable.
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: 460 },
  // Fixed minimum width (never shrinks) so "100% match" is not clipped and the bars of all rows stay the same length.
  matchLabel: {
    minWidth: 88,
    flexShrink: 0,
    textAlign: 'right',
    fontSize: 12.5,
    color: colors.textDim,
    fontVariant: ['tabular-nums'],
  },
  matchNum: { color: colors.text, fontWeight: '800' },
  flameSlot: { width: 16, alignItems: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  source: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  host: { flex: 1, minWidth: 0, fontSize: 12.5, color: colors.textMute },

  details: { borderTopWidth: 1, borderTopColor: colors.border, padding: space.lg, gap: 14 },
  sourceLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sourceText: { flex: 1, minWidth: 0 },
  sourceName: { lineHeight: 20 },
  subRow: { flexDirection: 'row', alignItems: 'center' },
  subHost: { flexShrink: 1, minWidth: 0 },
  subAge: { flexShrink: 0 },
  explain: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  explainIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  explainText: { flex: 1, minWidth: 0, gap: 2 },
  explainHead: { fontSize: 14, lineHeight: 20, fontWeight: '800', color: colors.text },
  explainTag: { fontWeight: '600', color: colors.textDim },
  // Wraps: stacked full-width on a phone, side by side on desktop.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 2 },
  primary: { flexGrow: 1, flexBasis: 220 },
  secondary: { flexGrow: 1, flexBasis: 130 },
});
