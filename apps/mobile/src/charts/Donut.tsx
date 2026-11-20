import { useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { fmtCompact } from '@/src/format';
import { colors, radius } from '@/src/theme';

import { arcPath, clamp, finite, pctText, TWO_PI } from './path';
import type { DonutDatum, DonutProps } from './types';
import { useReveal, useTween } from './useReveal';

/** Extra ring thickness (px) the highlighted slice grows by, split between the inside and the outside. */
const GROW = 6;
/** Visible gap between neighbouring slices, measured on the middle of the ring. */
const GAP_PX = 3;
/** Container width from which the legend sits beside the ring instead of below it. */
const WIDE_AT = 480;
const REVEAL_MS = 700;
/** Extra reach (px) around the ring that still counts as a tap on the nearest slice. */
const HIT_PAD = 12;

interface Row extends DonutDatum {
  /** Share of the total, 0..1. */
  share: number;
}

interface Slice extends Row {
  /** Start and end of the slice as fractions of the full turn (0 = 12 o'clock, clockwise). */
  from: number;
  to: number;
}

const WEB_TAP: ViewStyle =
  Platform.OS === 'web' ? ({ cursor: 'pointer', userSelect: 'none', touchAction: 'manipulation' } as unknown as ViewStyle) : {};

/**
 * Share-of-total ring with a tappable legend. Tapping a slice (or its legend row) highlights it and shows its
 * value in the hole; tapping it again clears. The sweep-in plays once on first mount: the dashboard polls every
 * few seconds and those updates just redraw the arcs.
 */
export function Donut({
  data,
  size = 200,
  thickness = 26,
  centerValue,
  centerLabel,
  legend = true,
  formatValue = fmtCompact,
  title,
}: DonutProps) {
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  // The slice that was highlighted most recently: it keeps its thickness while the highlight fades out.
  const [lastSelected, setLastSelected] = useState<string | null>(null);

  const wide = legend && width >= WIDE_AT;
  const sz = width > 0 ? Math.min(size, Math.floor(width)) : size;
  const th = clamp(thickness, 4, sz / 2 - GROW - 4);
  const mid = sz / 2;
  const rMid = mid - GROW / 2 - th / 2;
  const hole = sz - 2 * (th + GROW);

  const { rows, slices, total } = useMemo(() => {
    const clean = data.map((d) => ({ ...d, value: Math.max(0, finite(d.value)) }));
    const sum = clean.reduce((s, d) => s + d.value, 0);
    const allRows: Row[] = clean.map((d) => ({ ...d, share: sum > 0 ? d.value / sum : 0 }));
    let acc = 0;
    const visible: Slice[] = allRows
      .filter((r) => r.value > 0)
      .map((r) => {
        const slice = { ...r, from: acc, to: acc + r.share };
        acc += r.share;
        return slice;
      });
    return { rows: allRows, slices: visible, total: sum };
  }, [data]);

  const empty = total <= 0;
  const sel = selected != null ? slices.find((s) => s.key === selected) : undefined;
  const focus = useTween(sel ? 1 : 0);
  const focusKey = sel ? sel.key : lastSelected;
  const sweep = useReveal(width > 0 && !empty, REVEAL_MS);

  const choose = (key: string | null): void => {
    if (key == null || key === sel?.key) {
      setSelected(null);
      return;
    }
    setSelected(key);
    setLastSelected(key);
  };

  /** Which slice is under a point of the ring box (null: the hole or outside the ring). */
  const hitTest = (x: number, y: number): string | null => {
    const dx = x - mid;
    const dy = y - mid;
    const r = Math.hypot(dx, dy);
    if (r < rMid - th / 2 - HIT_PAD || r > rMid + th / 2 + GROW / 2 + HIT_PAD || slices.length === 0) return null;
    let f = Math.atan2(dx, -dy) / TWO_PI;
    if (f < 0) f += 1;
    const hit = slices.find((s) => f >= s.from && f < s.to);
    return (hit ?? slices[slices.length - 1]).key;
  };

  // A press on the ring box. `Pressable` only reports real taps (a scroll that starts on the ring is not one, on
  // native and on the web, where it maps to `click`). Coordinates: `locationX/Y` on native, `offsetX/Y` on the web.
  const onRingPress = (e: GestureResponderEvent): void => {
    const p = e.nativeEvent as unknown as { locationX?: number; locationY?: number; offsetX?: number; offsetY?: number };
    const x = p.locationX ?? p.offsetX;
    const y = p.locationY ?? p.offsetY;
    if (x != null && y != null) choose(hitTest(x, y));
  };

  const onLayout = (e: LayoutChangeEvent): void => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidth((prev) => (prev === w ? prev : w));
  };

  const arcs = slices.map((s) => {
    const span = (s.to - s.from) * TWO_PI;
    const gap = slices.length > 1 ? Math.min(GAP_PX / rMid, span * 0.5) : 0;
    const a0 = s.from * TWO_PI + gap / 2;
    const a1 = sweep >= s.to ? s.to * TWO_PI - gap / 2 : sweep * TWO_PI;
    if (a1 - a0 < 0.004) return null;
    const isFocus = s.key === focusKey;
    return (
      <Path
        key={s.key}
        d={arcPath(mid, mid, rMid, a0, a1)}
        fill="none"
        stroke={s.color}
        strokeWidth={th + (isFocus ? GROW * focus : 0)}
        opacity={isFocus ? 1 : 1 - 0.62 * focus}
      />
    );
  });

  const name = title ?? (centerLabel ? `${centerLabel.charAt(0).toUpperCase()}${centerLabel.slice(1)} breakdown` : 'Breakdown');
  const summary = empty
    ? `${name}: no data yet`
    : `${name}: ${rows
        .filter((r) => r.value > 0)
        .map((r) => `${r.label} ${pctText(r.share)}`)
        .join(', ')}`;

  const fit = (text: string): number => clamp(Math.floor((hole - 16) / (Math.max(1, text.length) * 0.6)), 15, 26);
  const selValue = sel ? formatValue(sel.value) : '';
  const centre = empty ? (
    <Text style={styles.noData} maxFontSizeMultiplier={1.15}>
      No data yet
    </Text>
  ) : sel ? (
    <>
      <Text style={[styles.centerValue, { fontSize: fit(selValue) }]} numberOfLines={1} maxFontSizeMultiplier={1.15}>
        {selValue}
      </Text>
      <View style={styles.selRow}>
        <View style={[styles.selDot, { backgroundColor: sel.color }]} />
        <Text style={styles.centerLabel} numberOfLines={1} maxFontSizeMultiplier={1.15}>
          {sel.label} · {pctText(sel.share)}
        </Text>
      </View>
    </>
  ) : (
    <>
      {centerValue != null && (
        <Text style={[styles.centerValue, { fontSize: fit(centerValue) }]} numberOfLines={1} maxFontSizeMultiplier={1.15}>
          {centerValue}
        </Text>
      )}
      {centerLabel != null && (
        <Text style={styles.centerLabel} numberOfLines={1} maxFontSizeMultiplier={1.15}>
          {centerLabel}
        </Text>
      )}
    </>
  );

  return (
    <View
      onLayout={onLayout}
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
      style={[styles.root, wide ? styles.rootWide : styles.rootNarrow, { opacity: width > 0 ? 1 : 0 }]}
    >
      <View style={{ width: sz, height: sz }}>
        <Svg width={sz} height={sz}>
          <Circle
            cx={mid}
            cy={mid}
            r={rMid}
            fill="none"
            stroke={colors.border}
            strokeWidth={th}
            opacity={empty ? 1 : 0.4}
          />
          {arcs}
        </Svg>
        <View pointerEvents="none" style={styles.centre}>
          <View style={[styles.centreInner, { maxWidth: Math.max(40, hole - 8) }]}>{centre}</View>
        </View>
        {!empty && (
          <Pressable
            accessible={false}
            focusable={false}
            importantForAccessibility="no"
            accessibilityElementsHidden
            onPress={onRingPress}
            style={[styles.fill, WEB_TAP]}
          />
        )}
      </View>

      {legend && (
        <View style={[styles.legend, wide ? styles.legendWide : styles.legendNarrow]}>
          {rows.map((r) => {
            const isSel = sel?.key === r.key;
            const disabled = r.value <= 0;
            const valueText = formatValue(r.value);
            return (
              <Pressable
                key={r.key}
                disabled={disabled}
                onPress={() => choose(r.key)}
                accessibilityRole="button"
                accessibilityLabel={`${r.label}, ${valueText}, ${pctText(r.share)}`}
                accessibilityState={{ selected: isSel, disabled }}
                style={({ pressed }) => [
                  styles.row,
                  isSel && styles.rowSelected,
                  (disabled || (sel != null && !isSel)) && styles.rowDim,
                  pressed && styles.rowPressed,
                ]}
              >
                <View style={[styles.dot, { backgroundColor: r.color }]} />
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {r.label}
                </Text>
                <Text style={styles.rowValue}>{valueText}</Text>
                <Text style={styles.rowPct}>{pctText(r.share)}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%' },
  rootNarrow: { alignItems: 'center', gap: 16 },
  rootWide: { flexDirection: 'row', alignItems: 'center', gap: 28 },

  fill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  centre: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  centreInner: { alignItems: 'center', justifyContent: 'center' },
  centerValue: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.6,
    fontVariant: ['tabular-nums'],
  },
  centerLabel: { color: colors.textDim, fontSize: 12.5, fontWeight: '600', marginTop: 1 },
  noData: { color: colors.textMute, fontSize: 13, fontWeight: '600' },
  selRow: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  selDot: { width: 8, height: 8, borderRadius: 4, marginTop: 1 },

  legend: { gap: 2 },
  legendNarrow: { alignSelf: 'stretch' },
  legendWide: { flex: 1, minWidth: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  rowSelected: { backgroundColor: colors.cardHi, borderColor: colors.border },
  rowDim: { opacity: 0.5 },
  rowPressed: { opacity: 0.85 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  rowLabel: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14.5, fontWeight: '600' },
  rowValue: { color: colors.textDim, fontSize: 13.5, fontVariant: ['tabular-nums'] },
  rowPct: {
    minWidth: 46,
    textAlign: 'right',
    color: colors.text,
    fontSize: 14.5,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
