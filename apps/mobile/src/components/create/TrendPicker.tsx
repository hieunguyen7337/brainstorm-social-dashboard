import { FontAwesome6, Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { fmtPct } from '@/src/format';
import { colors, radius, space, trendSourceMeta, type as t, withAlpha } from '@/src/theme';
import type { Trend } from '@/src/types';
import { Button, Card, IconButton, Skeleton, haptic } from '@/src/ui';

import { TREND_SHOWN, type TrendChoice } from './logic';

export interface TrendPickerProps {
  /** The current choice (the full record is attached once it is known). */
  choice: TrendChoice | null;
  open: boolean;
  onToggle: () => void;
  /** Trends from the API, best first. `undefined` until they load. */
  list: Trend[] | undefined;
  loading: boolean;
  failed: boolean;
  retrying: boolean;
  onRetry: () => void;
  onPick: (trend: Trend) => void;
  onClear: () => void;
}

interface SourceLook {
  label: string;
  color: string;
  /** Font Awesome brand glyph; empty for an unknown source. */
  icon: string;
}

const UNKNOWN_SOURCE: SourceLook = { label: 'Trending', color: colors.textDim, icon: '' };
const sourceOf = (source: string): SourceLook =>
  (trendSourceMeta as Record<string, SourceLook | undefined>)[source] ?? UNKNOWN_SOURCE;

function SourceGlyph({ look, size }: { look: SourceLook; size: number }) {
  return look.icon ? (
    <FontAwesome6 name={look.icon} size={size} color={look.color} brand />
  ) : (
    <Ionicons name="globe-outline" size={size + 2} color={look.color} />
  );
}

/** Small "Hacker News" style pill. */
function SourceBadge({ source }: { source: string }) {
  const look = sourceOf(source);
  return (
    <View style={[styles.badge, { backgroundColor: withAlpha(look.color, 0.14), borderColor: withAlpha(look.color, 0.4) }]}>
      <SourceGlyph look={look} size={10} />
      <Text style={[styles.badgeText, { color: look.color }]} numberOfLines={1}>
        {look.label}
      </Text>
    </View>
  );
}

function TrendRow({
  trend,
  selected,
  last,
  onPress,
}: {
  trend: Trend;
  selected: boolean;
  last: boolean;
  onPress: () => void;
}) {
  const look = sourceOf(trend.source);
  const match = fmtPct(trend.relevance, 0);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${trend.title}, ${look.label}, ${match} match`}
      onPress={() => {
        haptic.select();
        onPress();
      }}
      style={({ pressed }) => [
        styles.item,
        !last && styles.itemDivider,
        selected && { backgroundColor: withAlpha(colors.accent, 0.12) },
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.glyph, { backgroundColor: withAlpha(look.color, 0.16) }]}>
        <SourceGlyph look={look} size={14} />
      </View>
      <View style={styles.itemText}>
        <Text style={styles.itemTitle} numberOfLines={2}>
          {trend.title}
        </Text>
        <Text style={styles.itemMeta} numberOfLines={1}>
          {`${look.label}  ·  ${match} match`}
        </Text>
      </View>
      {selected ? <Ionicons name="checkmark-circle" size={20} color={colors.accent} /> : null}
    </Pressable>
  );
}

/** Optional trend: a row showing the choice (or a prompt) that expands into an inline list of what's trending. */
export function TrendPicker({
  choice,
  open,
  onToggle,
  list,
  loading,
  failed,
  retrying,
  onRetry,
  onPick,
  onClear,
}: TrendPickerProps) {
  const full = choice?.full;
  const shown = (list ?? []).slice(0, TREND_SHOWN);

  let listBody;
  if (loading) {
    listBody = (
      <View style={styles.skeletons}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={styles.skeletonRow}>
            <Skeleton width={32} height={32} rounded={16} />
            <View style={styles.skeletonText}>
              <Skeleton width="90%" height={13} />
              <Skeleton width="45%" height={11} />
            </View>
          </View>
        ))}
      </View>
    );
  } else if (failed) {
    listBody = (
      <View style={styles.note}>
        <Text style={styles.noteText}>{"Couldn't load trends right now. You can still generate without one."}</Text>
        <Button title="Try again" icon="refresh" variant="secondary" small loading={retrying} onPress={onRetry} />
      </View>
    );
  } else if (shown.length === 0) {
    listBody = (
      <View style={styles.note}>
        <Text style={styles.noteText}>No trends yet. Check back in a minute.</Text>
      </View>
    );
  } else {
    listBody = shown.map((tr, i) => (
      <TrendRow
        key={tr.id}
        trend={tr}
        selected={tr.id === choice?.id}
        last={i === shown.length - 1}
        onPress={() => onPick(tr)}
      />
    ));
  }

  return (
    <View style={styles.wrap}>
      <Text style={t.label}>Trend</Text>
      <Card
        tone="raised"
        padded={false}
        onPress={onToggle}
        accessibilityLabel={choice ? `Trend: ${choice.title}. Tap to change.` : 'Pick a trend (optional)'}
      >
        <View style={styles.row}>
          <View style={[styles.iconWrap, { backgroundColor: withAlpha(colors.accent, choice ? 0.2 : 0.12) }]}>
            <Ionicons name="trending-up" size={18} color={colors.accent} />
          </View>
          <View style={styles.rowText}>
            {choice ? (
              <>
                <Text style={t.h3} numberOfLines={2}>
                  {choice.title}
                </Text>
                {full ? (
                  <View style={styles.meta}>
                    <SourceBadge source={full.source} />
                    <Text style={styles.metaText}>{`${fmtPct(full.relevance, 0)} match`}</Text>
                  </View>
                ) : null}
              </>
            ) : (
              <>
                <Text style={t.h3}>Pick a trend (optional)</Text>
                <Text style={styles.metaText}>Ride what people are talking about right now</Text>
              </>
            )}
          </View>
          {choice ? (
            <IconButton icon="close" label="Clear trend" size={18} onPress={onClear} />
          ) : (
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textMute} />
          )}
        </View>
      </Card>
      {open ? (
        <Card padded={false} style={styles.list}>
          {listBody}
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, minHeight: 64 },
  iconWrap: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, minWidth: 0, gap: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  metaText: { fontSize: 12.5, color: colors.textDim },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  badgeText: { fontSize: 11.5, fontWeight: '700', letterSpacing: 0.2 },
  list: { overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingVertical: 12, minHeight: 56 },
  itemDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  pressed: { opacity: 0.85 },
  glyph: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  itemText: { flex: 1, minWidth: 0, gap: 2 },
  itemTitle: { fontSize: 14.5, lineHeight: 20, fontWeight: '600', color: colors.text },
  itemMeta: { fontSize: 12.5, color: colors.textMute },
  skeletons: { padding: space.md, gap: space.lg },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  skeletonText: { flex: 1, gap: 6 },
  note: { padding: space.lg, gap: space.md, alignItems: 'flex-start' },
  noteText: { fontSize: 13.5, lineHeight: 19, color: colors.textDim },
});
