import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { fmtCompact } from '@/src/format';
import { colors, gradient } from '@/src/theme';

import { finite, lerpColor, roundedPolygon, type Pt } from './path';
import type { FunnelProps } from './types';
import { useUid } from './useReveal';

/** Vertical gap between two stages. */
const GAP = 4;
/** The funnel never gets wider than this, it stays centred on big screens. */
const MAX_W = 560;
/** Narrowest stage as a fraction of the full width. */
const FLOOR = 0.22;
const PILL_H = 22;
const CORNER = 7;
const NATIVE = Platform.OS !== 'web';

interface Stage {
  key: string;
  label: string;
  value: number;
  valueText: string;
  /** Conversion from the previous stage, 0..1. */
  rate: number;
  /** Top and bottom edge widths as a fraction of the funnel width. */
  wTop: number;
  wBot: number;
}

/**
 * Stage widths (fractions of the full width) on a compressed scale: raw ratios collapse (clicks and conversions
 * are tiny next to views), so the data's (value / first)^0.35 is blended with an even taper. The result always
 * narrows from the first stage down to FLOOR, never widens, and still orders the stages by size.
 */
function stageWidths(values: number[]): number[] {
  const n = values.length;
  const first = values[0] > 0 ? values[0] : 0;
  const out: number[] = [];
  let above = 1;
  for (let i = 0; i < n; i++) {
    const ratio = first > 0 ? Math.min(1, values[i] / first) : 0;
    const compressed = Math.max(FLOOR, Math.pow(ratio, 0.35));
    const even = n > 1 ? 1 - (1 - FLOOR) * (i / (n - 1)) : 1;
    const w = i === 0 ? 1 : Math.min(above, 0.5 * compressed + 0.5 * even);
    out.push(w);
    above = w;
  }
  return out;
}

/** 0.0523 -> "5.2%", 0.0004 -> "<0.1%", 1 -> "100%". */
function fmtRate(rate: number): string {
  const p = rate * 100;
  if (!(p > 0)) return '0%';
  if (p < 0.05) return '<0.1%';
  if (p >= 99.95) return `${Math.round(p)}%`;
  return `${p.toFixed(1)}%`;
}

/**
 * The whiteboard's sales funnel: stacked trapezoids narrowing from Views down to Conversions, a violet to pink
 * gradient flowing through them, the stage's compact value, and the conversion rate from the stage above as a
 * pill on the seam between them. Stages ease in one after the other on first mount only.
 */
export function Funnel({ data, height = 260, title }: FunnelProps) {
  const uid = useUid();
  const [width, setWidth] = useState(0);
  const W = Math.min(width, MAX_W);
  const n = data.length;
  const empty = !data.some((d) => finite(d.value) > 0);

  const stages = useMemo<Stage[]>(() => {
    const values = data.map((d) => Math.max(0, finite(d.value)));
    const wTop = stageWidths(values);
    return data.map((d, i) => {
      const prev = i > 0 ? values[i - 1] : 0;
      const rate = Number.isFinite(d.rate) ? Math.max(0, d.rate) : prev > 0 ? values[i] / prev : 0;
      return {
        key: d.key,
        label: d.label,
        value: values[i],
        valueText: fmtCompact(values[i]),
        rate,
        wTop: wTop[i],
        wBot: i < data.length - 1 ? wTop[i + 1] : wTop[i] * 0.8,
      };
    });
  }, [data]);

  // Entrance: one Animated.Value per stage, driven natively where possible (opacity + transform only).
  const anims = useRef<Animated.Value[]>([]);
  const entered = useRef(false);
  const ready = W > 0 && n > 0 && !empty;
  if (ready) {
    while (anims.current.length < n) anims.current.push(new Animated.Value(entered.current ? 1 : 0));
  }
  useEffect(() => {
    if (!ready || entered.current) return;
    let stopped = false;
    let running: Animated.CompositeAnimation | undefined;
    const play = (): void => {
      if (stopped) return;
      entered.current = true;
      running = Animated.stagger(
        90,
        anims.current.map((v) =>
          Animated.timing(v, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }),
        ),
      );
      running.start();
    };
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (stopped) return;
      if (reduce) {
        anims.current.forEach((v) => v.setValue(1));
        entered.current = true;
      } else {
        play();
      }
    }, play);
    return () => {
      stopped = true;
      if (running) {
        running.stop();
        anims.current.forEach((v) => v.setValue(1));
      }
    };
  }, [ready]);

  const onLayout = (e: LayoutChangeEvent): void => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidth((prev) => (prev === w ? prev : w));
  };

  const summary = empty
    ? `${title ?? 'Sales funnel'}: no data yet`
    : `${title ?? 'Sales funnel'}: ${stages
        .map(
          (s, i) =>
            `${s.label} ${s.valueText}${i > 0 ? `, ${fmtRate(s.rate)} of ${stages[i - 1].label.toLowerCase()}` : ''}`,
        )
        .join('; ')}`;

  let body = null;
  if (empty && width > 0) {
    body = (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No funnel data yet</Text>
      </View>
    );
  } else if (ready) {
    const stageH = Math.max(8, (height - GAP * (n - 1)) / n);
    const compact = stageH < 50;
    const cx = W / 2;
    body = (
      <View style={{ position: 'absolute', left: (width - W) / 2, top: 0, width: W, height }}>
        {stages.map((s, i) => {
          const topW = s.wTop * W;
          const botW = s.wBot * W;
          const c0 = lerpColor(gradient.colors[0], gradient.colors[1], i / n);
          const c1 = lerpColor(gradient.colors[0], gradient.colors[1], (i + 1) / n);
          const pts: Pt[] = [
            { x: cx - topW / 2, y: 0.5 },
            { x: cx + topW / 2, y: 0.5 },
            { x: cx + botW / 2, y: stageH - 0.5 },
            { x: cx - botW / 2, y: stageH - 0.5 },
          ];
          // Does the label + value fit inside the trapezoid? If not it goes beside it, never clipped.
          const textW = compact
            ? s.label.length * 7.4 + s.valueText.length * 10 + 10
            : Math.max(s.label.length * 7.4, s.valueText.length * 10.6);
          const usable = Math.min(topW, botW) + Math.abs(topW - botW) * 0.35 - 20;
          const inside = textW <= usable;
          const boxW = (topW + botW) / 2;
          const besideLeft = cx + topW / 2 + 12;
          // Pills overlap the top and bottom edge of a stage: keep the text centred between them.
          const nudge = ((i > 0 ? 1 : 0) - (i < n - 1 ? 1 : 0)) * 4;

          const a = anims.current[i];
          const entrance = a
            ? {
                opacity: a,
                transform: [
                  { translateY: a.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) },
                  { scaleX: a.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }) },
                ],
              }
            : null;
          const gid = `${uid}-f${i}`;

          return (
            <Animated.View
              key={s.key}
              pointerEvents="none"
              style={[styles.stage, { top: i * (stageH + GAP), width: W, height: stageH }, entrance]}
            >
              <Svg width={W} height={stageH}>
                <Defs>
                  <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor={c0} />
                    <Stop offset="1" stopColor={c1} />
                  </LinearGradient>
                </Defs>
                <Path
                  d={roundedPolygon(pts, CORNER)}
                  fill={`url(#${gid})`}
                  stroke="rgba(255,255,255,0.16)"
                  strokeWidth={1}
                />
              </Svg>

              {inside ? (
                <View style={[styles.textBox, { top: nudge, left: cx - boxW / 2, width: boxW, height: stageH }]}>
                  <View style={compact ? styles.textRow : styles.textCol}>
                    <Text style={styles.labelOn} numberOfLines={1} maxFontSizeMultiplier={1.1}>
                      {s.label}
                    </Text>
                    <Text style={styles.valueOn} numberOfLines={1} maxFontSizeMultiplier={1.1}>
                      {s.valueText}
                    </Text>
                  </View>
                </View>
              ) : (
                <View
                  style={[
                    styles.textBox,
                    { left: besideLeft, width: Math.max(0, W - besideLeft), height: stageH, alignItems: 'flex-start' },
                  ]}
                >
                  <View style={styles.textColStart}>
                    <Text style={styles.labelBeside} numberOfLines={1} maxFontSizeMultiplier={1.1}>
                      {s.label}
                    </Text>
                    <Text style={styles.valueBeside} numberOfLines={1} maxFontSizeMultiplier={1.1}>
                      {s.valueText}
                    </Text>
                  </View>
                </View>
              )}

              {i > 0 && (
                <View style={styles.pillSlot}>
                  <View style={[styles.pill, { maxWidth: Math.max(60, W - 8) }]}>
                    <Text style={styles.pillText} numberOfLines={1} maxFontSizeMultiplier={1.1}>
                      {fmtRate(s.rate)} of {stages[i - 1].label.toLowerCase()}
                    </Text>
                  </View>
                </View>
              )}
            </Animated.View>
          );
        })}
      </View>
    );
  }

  return (
    <View
      onLayout={onLayout}
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
      style={[styles.root, { height }]}
    >
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%' },
  stage: { position: 'absolute', left: 0 },
  textBox: { position: 'absolute', top: 0, alignItems: 'center', justifyContent: 'center' },
  textCol: { alignItems: 'center' },
  textColStart: { alignItems: 'flex-start' },
  textRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },

  labelOn: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    textShadowColor: 'rgba(11,16,32,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  valueOn: {
    color: colors.white,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.4,
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(11,16,32,0.35)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  labelBeside: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  valueBeside: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.4,
    fontVariant: ['tabular-nums'],
  },

  // Sits on the seam above its stage: half of it overlaps the stage above, half this stage.
  pillSlot: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: -(GAP + PILL_H) / 2,
    height: PILL_H,
    alignItems: 'center',
  },
  pill: {
    height: PILL_H,
    paddingHorizontal: 9,
    borderRadius: PILL_H / 2,
    justifyContent: 'center',
    backgroundColor: 'rgba(11,16,32,0.86)',
    borderWidth: 1,
    borderColor: colors.borderHi,
  },
  pillText: { color: colors.text, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },

  empty: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.textMute, fontSize: 13, fontWeight: '600' },
});
