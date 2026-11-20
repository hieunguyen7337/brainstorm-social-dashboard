/**
 * The data blocks of the "What's working" card: top themes with lift bars, the per-platform rate table and the
 * real-vs-simulated sources split. Presentational only: props in, no data fetching (the card owns that).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { STAGE_LABEL } from '@/src/config';
import { fmtChange, fmtInt, fmtPct } from '@/src/format';
import { colors, platformMeta, space, type as t, withAlpha } from '@/src/theme';
import type { InsightSources, PlatformRate, ThemeInsight } from '@/src/types';
import { PlatformIcon, haptic } from '@/src/ui';
import {
  platformRows,
  postsLabel,
  sourcesView,
  themeRows,
  type LiftTone,
  type PlatformRow,
  type ThemeRow,
} from './insights-model';

/** Lift pill and bar colours: better than average green, worse red, level neutral. */
const TONE: Record<LiftTone, string> = { up: colors.success, down: colors.danger, flat: colors.textDim };
/** Muted, so "simulated" never competes with the green of real data. */
const SIMULATED = withAlpha(colors.textMute, 0.6);
const TRACK = withAlpha(colors.textMute, 0.18);
/** Width of each rate column of the platform table (fits "ONBOARD" and "100.0%"; leaves the name room at 320px). */
const COLUMN_W = 56;
/** Column heads: engagement rate, click-through rate, and the last funnel stage ("Onboard"). */
const COLUMNS = ['Engage', 'CTR', STAGE_LABEL.conversions] as const;

/** Small uppercase section label with an optional muted hint on the right. */
function BlockLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <View style={styles.labelRow}>
      <Text style={[t.label, styles.labelText]} numberOfLines={1}>
        {label}
      </Text>
      {hint ? (
        <Text style={styles.hint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

// ---- top themes ---------------------------------------------------------------------------------------

/**
 * Thin bar that grows to `percent` (0..100) on mount and glides to the new length when a re-learn changes it.
 * Width cannot use the native driver, so this stays on the JS thread: four 4px bars for half a second is cheap.
 */
function GrowBar({ percent, color, delay = 0 }: { percent: number; color: string; delay?: number }) {
  const length = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(length, {
      toValue: percent,
      duration: 520,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [length, percent, delay]);

  return (
    <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View
        style={[
          styles.fill,
          {
            backgroundColor: color,
            width: length.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'], extrapolate: 'clamp' }),
          },
        ]}
      />
    </View>
  );
}

function LiftPill({ pct, tone }: { pct: number; tone: LiftTone }) {
  const c = TONE[tone];
  return (
    <View style={[styles.pill, { backgroundColor: withAlpha(c, 0.14), borderColor: withAlpha(c, 0.4) }]}>
      <Text style={[styles.pillText, { color: c }]} numberOfLines={1}>
        {fmtChange(pct)}
      </Text>
    </View>
  );
}

function ThemeRowView({ row, index }: { row: ThemeRow; index: number }) {
  return (
    <View
      style={styles.themeRow}
      accessible
      accessibilityLabel={`${row.name}, ${postsLabel(row.posts)}, ${fmtChange(row.pct)} compared with your average`}
      testID="insight-theme"
    >
      <View style={styles.themeTop}>
        <View style={[styles.dot, { backgroundColor: row.color ?? colors.accent }]} />
        <Text style={styles.themeName} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={styles.themePosts} numberOfLines={1}>
          {postsLabel(row.posts)}
        </Text>
        <LiftPill pct={row.pct} tone={row.tone} />
      </View>
      <GrowBar percent={row.bar} color={TONE[row.tone]} delay={index * 70} />
    </View>
  );
}

/** The best content themes (up to four) with how much better or worse than average each performs. */
export function ThemesBlock({ themes }: { themes: readonly ThemeInsight[] }) {
  const rows = useMemo(() => themeRows(themes), [themes]);
  return (
    <View style={styles.block} testID="insights-themes">
      <BlockLabel label="Top themes" hint="vs your average" />
      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="color-palette-outline" size={18} color={colors.textMute} />
          <Text style={styles.emptyText}>Tag your posts with a theme and the winners show up here.</Text>
        </View>
      ) : (
        <View style={styles.themeList}>
          {rows.map((row, i) => (
            <ThemeRowView key={row.key} row={row} index={i} />
          ))}
        </View>
      )}
    </View>
  );
}

// ---- per-platform rates -------------------------------------------------------------------------------

function RateRowView({ row }: { row: PlatformRow }) {
  const label = platformMeta[row.platform].label;
  const cells = row.rates ? row.rates.map((r) => fmtPct(r, 1)) : null;
  const spoken = cells
    ? `${label}: engagement ${cells[0]}, click rate ${cells[1]}, ${STAGE_LABEL.conversions} ${cells[2]}`
    : `${label}: no data yet`;
  return (
    <View style={styles.tRow} accessible accessibilityLabel={spoken} testID="insight-platform">
      <View style={styles.tName}>
        <PlatformIcon platform={row.platform} size={14} />
        <Text style={styles.tNameText} numberOfLines={1}>
          {label}
        </Text>
      </View>
      {COLUMNS.map((name, col) => (
        <Text
          key={name}
          style={[styles.tCell, !cells && styles.tNone, cells && row.best[col] && styles.tBest]}
          numberOfLines={1}
        >
          {cells ? cells[col] : '–'}
        </Text>
      ))}
    </View>
  );
}

/** Engagement, click-through and onboard rate per platform; the best value of each column stands out. */
export function PlatformRatesBlock({ rates }: { rates: readonly PlatformRate[] }) {
  const rows = useMemo(() => platformRows(rates), [rates]);
  if (rows.length === 0) return null;
  return (
    <View style={styles.block} testID="insights-platforms">
      <View style={styles.tHead}>
        <Text style={[t.label, styles.tHeadName]} numberOfLines={1}>
          By platform
        </Text>
        {COLUMNS.map((name) => (
          <Text key={name} style={styles.tHeadCell} numberOfLines={1}>
            {name}
          </Text>
        ))}
      </View>
      <View>
        {rows.map((row) => (
          <RateRowView key={row.platform} row={row} />
        ))}
      </View>
    </View>
  );
}

// ---- sources ------------------------------------------------------------------------------------------

function LegendItem({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
      <Text style={styles.legendValue}>{fmtInt(value)}</Text>
    </View>
  );
}

function LinkButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={({ pressed }) => [styles.link, pressed && styles.pressed]}
    >
      <Text style={styles.linkText}>{label}</Text>
      <Ionicons name="chevron-forward" size={14} color={colors.accent} />
    </Pressable>
  );
}

/**
 * Where the numbers come from: a real-vs-simulated bar, a legend and one honest sentence. Hidden when there is
 * nothing behind the numbers yet.
 */
export function SourcesBlock({ sources, onOpenSettings }: { sources: InsightSources; onOpenSettings: () => void }) {
  const view = useMemo(() => sourcesView(sources), [sources]);
  if (view.total === 0) return null;
  return (
    <View style={styles.block} testID="insights-sources">
      <BlockLabel label="Sources" />
      <View style={styles.split} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {view.real > 0 ? <View style={[styles.segment, { flex: view.real, backgroundColor: colors.success }]} /> : null}
        {view.simulated > 0 ? (
          <View style={[styles.segment, { flex: view.simulated, backgroundColor: SIMULATED }]} />
        ) : null}
      </View>
      <View style={styles.legend}>
        <LegendItem color={colors.success} label="Real" value={view.real} />
        <LegendItem color={SIMULATED} label="Simulated" value={view.simulated} />
      </View>
      <Text style={styles.sentence}>{view.sentence}</Text>
      {view.real === 0 ? <LinkButton label="Open Settings" onPress={onOpenSettings} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.sm },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  labelText: { flexShrink: 1 },
  hint: { flexShrink: 0, color: colors.textMute, fontSize: 12, fontWeight: '600' },

  // top themes
  themeList: { gap: space.md },
  themeRow: { gap: 6 },
  themeTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  themeName: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14.5, fontWeight: '700' },
  themePosts: { flexShrink: 0, color: colors.textMute, fontSize: 12.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pill: {
    flexShrink: 0,
    minWidth: 54,
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillText: { fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  track: { height: 4, borderRadius: 2, backgroundColor: TRACK, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 2 },
  empty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: 12,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyText: { flex: 1, minWidth: 0, color: colors.textDim, fontSize: 13.5, lineHeight: 19 },

  // platform table
  tHead: { flexDirection: 'row', alignItems: 'center', paddingBottom: 6 },
  tHeadName: { flex: 1, minWidth: 0 },
  tHeadCell: {
    width: COLUMN_W,
    textAlign: 'right',
    color: colors.textMute,
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  tRow: { flexDirection: 'row', alignItems: 'center', minHeight: 38, borderTopWidth: 1, borderTopColor: colors.border },
  tName: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  tNameText: { flexShrink: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  tCell: {
    width: COLUMN_W,
    textAlign: 'right',
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  tBest: { color: colors.success, fontWeight: '800' },
  tNone: { color: colors.textMute },

  // sources
  split: {
    flexDirection: 'row',
    height: 8,
    gap: 2,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: TRACK,
  },
  segment: { height: '100%' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.lg, rowGap: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  legendValue: { color: colors.text, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  sentence: { color: colors.textDim, fontSize: 13.5, lineHeight: 19 },
  link: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 40, marginTop: -space.xs },
  linkText: { color: colors.accent, fontSize: 13.5, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
