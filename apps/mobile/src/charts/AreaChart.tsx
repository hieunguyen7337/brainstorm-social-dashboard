import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PointerEvent as RNPointerEvent,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, Line, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { fmtCompact, fmtDay } from '@/src/format';
import { colors } from '@/src/theme';

import { areaPath, clamp, finite, monotonePath, niceTicks } from './path';
import type { AreaChartProps } from './types';
import { useReveal, useUid } from './useReveal';

/** Room above and below the plot lines so strokes and dots are never clipped. */
const PAD_TOP = 10;
const PAD_BOTTOM = 10;
/** Horizontal inset of the first and last point inside the plot (room for the cursor dot's halo). */
const PAD_X = 10;
/** Height of the x-axis label row under the plot. */
const X_LABEL_H = 22;
const REVEAL_MS = 800;
/** How long the tooltip stays after a finger is lifted. */
const HIDE_AFTER_MS = 1400;
/** A touch that stays put this long starts showing the tooltip (a tap or a horizontal drag show it sooner). */
const HOLD_MS = 150;
/** Horizontal travel (px) that turns a touch into a scrub. A mostly vertical drag is the page scrolling. */
const SLOP = 6;

/** Web only: let the page scroll vertically but give horizontal drags to the chart, no text selection. */
const WEB_SCRUB: ViewStyle =
  Platform.OS === 'web'
    ? ({ touchAction: 'pan-y', userSelect: 'none', cursor: 'crosshair' } as unknown as ViewStyle)
    : {};

/** x of a web pointer event relative to the element it is bound to. */
function webX(e: RNPointerEvent): number {
  const el = e.currentTarget as unknown as { getBoundingClientRect?: () => { left: number } };
  const left = el.getBoundingClientRect?.().left;
  return left != null ? e.nativeEvent.clientX - left : e.nativeEvent.offsetX;
}

/**
 * Smooth time series: one monotone-cubic line plus a fading gradient area per series, dashed grid, compact
 * axis labels, and a scrubbable crosshair with a tooltip (touch drag, or hover on the web). The left-to-right
 * reveal plays once on first mount; polling updates just redraw.
 */
export function AreaChart({
  labels,
  series,
  height = 180,
  formatValue = fmtCompact,
  formatLabel = fmtDay,
  title,
}: AreaChartProps) {
  const uid = useUid();
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const activeRef = useRef<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const n = labels.length;
  const plottable = n >= 2 && series.length > 0;
  const multi = series.length > 1;

  // Data model: cleaned values and the y axis. Independent of the measured width.
  const model = useMemo(() => {
    if (!plottable) return null;
    const cleaned = series.map((s) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      values: labels.map((_, i) => Math.max(0, finite(s.values[i]))),
    }));
    let max = 0;
    for (const s of cleaned) for (const v of s.values) if (v > max) max = v;
    const { ticks, top } = niceTicks(max);
    return { cleaned, ticks, top, tickTexts: ticks.map((t) => formatValue(t)) };
  }, [plottable, labels, series, formatValue]);

  // Pixel geometry for the measured width.
  const geo = useMemo(() => {
    if (!model || width <= 0) return null;
    const chars = Math.max(...model.tickTexts.map((t) => t.length));
    const yW = clamp(Math.ceil(chars * 6.4) + 10, 28, 64);
    const plotW = Math.max(60, width - yW);
    const step = (plotW - PAD_X * 2) / (n - 1);
    const plotH = height - PAD_TOP - PAD_BOTTOM;
    const yOf = (v: number): number => PAD_TOP + (1 - v / model.top) * plotH;
    const xs = labels.map((_, i) => PAD_X + i * step);
    const yBase = yOf(0);
    const lines = model.cleaned.map((s) => {
      const ys = s.values.map(yOf);
      const pts = xs.map((x, i) => ({ x, y: ys[i] }));
      const line = monotonePath(pts);
      return { ...s, ys, line, area: areaPath(line, pts[0], pts[n - 1], yBase) };
    });
    return { yW, plotW, step, xs, lines, ticks: model.ticks.map((t, i) => ({ y: yOf(t), text: model.tickTexts[i] })) };
  }, [model, width, height, n, labels]);

  const progress = useReveal(geo != null, REVEAL_MS);
  const revealing = progress < 1;
  const clipId = `${uid}-clip`;

  // Static layers are memoised as elements: while the reveal re-renders this component every frame React
  // sees the same element objects and skips their subtrees.
  const gridLayer = useMemo(() => {
    if (!geo) return null;
    const fillAlpha = multi ? 0.22 : 0.35;
    return (
      <>
        <Defs>
          {geo.lines.map((l, i) => (
            <LinearGradient key={l.key} id={`${uid}-a${i}`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={l.color} stopOpacity={fillAlpha} />
              <Stop offset="1" stopColor={l.color} stopOpacity={0} />
            </LinearGradient>
          ))}
        </Defs>
        {geo.ticks.map((t, i) => (
          <Line
            key={i}
            x1={0}
            x2={geo.plotW}
            y1={t.y}
            y2={t.y}
            stroke={colors.border}
            strokeWidth={1}
            strokeDasharray={i === 0 ? undefined : [4, 5]}
          />
        ))}
      </>
    );
  }, [geo, multi, uid]);

  const seriesLayer = useMemo(() => {
    if (!geo) return null;
    return (
      <>
        {geo.lines.map((l, i) => (
          <Path key={`a${l.key}`} d={l.area} fill={`url(#${uid}-a${i})`} />
        ))}
        {geo.lines.map((l) => (
          <Path
            key={`l${l.key}`}
            d={l.line}
            fill="none"
            stroke={l.color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </>
    );
  }, [geo, uid]);

  // ---- scrubbing -------------------------------------------------------------------------------------------
  // One small state machine for every input. A mouse hovers (web). A finger scrubs, but only once it has moved
  // sideways, rests for a moment or lifts as a tap: a vertical drag is the page scrolling and must not flash a
  // tooltip. The platform just feeds it events: pointer events on the web (the browser sends `pointercancel`
  // when it takes the gesture for scrolling), the responder system on iOS and Android (the ScrollView
  // terminates it).
  const touch = useRef<{ x0: number; live: boolean } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastX = useRef(0);

  const clearHide = (): void => {
    if (hideTimer.current != null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  const clearHold = (): void => {
    if (holdTimer.current != null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };
  const hide = (): void => {
    clearHide();
    activeRef.current = null;
    setActive(null);
  };
  const hideSoon = (): void => {
    clearHide();
    hideTimer.current = setTimeout(hide, HIDE_AFTER_MS);
  };
  useEffect(
    () => () => {
      if (hideTimer.current != null) clearTimeout(hideTimer.current);
      if (holdTimer.current != null) clearTimeout(holdTimer.current);
    },
    [],
  );

  const setFromX = (x: number): void => {
    if (!geo) return;
    const i = clamp(Math.round((x - PAD_X) / geo.step), 0, n - 1);
    if (activeRef.current !== i) {
      activeRef.current = i;
      setActive(i);
    }
  };

  const begin = (x: number): void => {
    clearHide();
    clearHold();
    lastX.current = x;
    touch.current = { x0: x, live: false };
    holdTimer.current = setTimeout(() => {
      const t = touch.current;
      if (t && !t.live) {
        t.live = true;
        setFromX(lastX.current);
      }
    }, HOLD_MS);
  };
  const move = (x: number): void => {
    lastX.current = x;
    const t = touch.current;
    if (!t) return;
    if (!t.live && Math.abs(x - t.x0) > SLOP) {
      t.live = true;
      clearHold();
    }
    if (t.live) setFromX(x);
  };
  const end = (): void => {
    const t = touch.current;
    touch.current = null;
    clearHold();
    if (!t) return;
    if (!t.live) setFromX(lastX.current);
    hideSoon();
  };
  const cancel = (): void => {
    touch.current = null;
    clearHold();
    hide();
  };

  const inputProps =
    Platform.OS === 'web'
      ? {
          onPointerDown: (e: RNPointerEvent): void => {
            if (e.nativeEvent.pointerType === 'touch') begin(webX(e));
          },
          onPointerMove: (e: RNPointerEvent): void => {
            if (e.nativeEvent.pointerType === 'touch') {
              move(webX(e));
              return;
            }
            clearHide();
            setFromX(webX(e));
          },
          onPointerUp: (e: RNPointerEvent): void => {
            if (e.nativeEvent.pointerType === 'touch') end();
          },
          onPointerCancel: (e: RNPointerEvent): void => {
            if (e.nativeEvent.pointerType === 'touch') cancel();
          },
          onPointerLeave: (e: RNPointerEvent): void => {
            if (e.nativeEvent.pointerType === 'touch') return;
            hide();
          },
        }
      : {
          onStartShouldSetResponder: () => true,
          onResponderGrant: (e: GestureResponderEvent): void => begin(e.nativeEvent.locationX),
          onResponderMove: (e: GestureResponderEvent): void => move(e.nativeEvent.locationX),
          onResponderRelease: (): void => end(),
          onResponderTerminate: (): void => cancel(),
        };

  const onLayout = (e: LayoutChangeEvent): void => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidth((prev) => (prev === w ? prev : w));
  };

  // ---- spoken summary ----------------------------------------------------------------------------------------
  const name = title ?? 'Trend chart';
  let summary = `${name}: not enough data yet`;
  if (model) {
    summary = `${name}: ${model.cleaned
      .map((s) => {
        let peak = 0;
        s.values.forEach((v, i) => {
          if (v > s.values[peak]) peak = i;
        });
        return `${s.label} ${formatValue(s.values[n - 1])} on ${formatLabel(labels[n - 1])}, peak ${formatValue(
          s.values[peak],
        )} on ${formatLabel(labels[peak])}`;
      })
      .join('; ')}`;
  }

  // ---- render ------------------------------------------------------------------------------------------------
  const boxH = height + X_LABEL_H;
  let body = null;

  if (!plottable) {
    body = (
      <View style={[styles.note, { height: boxH }]}>
        <Text style={styles.noteText}>Not enough data to chart yet</Text>
      </View>
    );
  } else if (!geo) {
    body = <View style={{ height: boxH }} />;
  } else {
    const idx = active != null && active < n ? active : null;
    const cx = idx != null ? geo.xs[idx] : 0;

    let tooltip = null;
    if (idx != null) {
      const head = formatLabel(labels[idx]);
      const rows = geo.lines.map((l) => ({ key: l.key, label: l.label, color: l.color, text: formatValue(l.values[idx]) }));
      // The bubble sits beside the crosshair, on the side with more room, and sizes itself to its content.
      const toRight = cx <= geo.plotW / 2;
      const side: ViewStyle = toRight
        ? { left: cx + 14, maxWidth: Math.max(60, geo.plotW - cx - 18) }
        : { right: geo.plotW - cx + 14, maxWidth: Math.max(60, cx - 18) };
      tooltip = (
        <View pointerEvents="none" style={[styles.tip, side]}>
          <Text style={styles.tipHead} numberOfLines={1}>
            {head}
          </Text>
          {rows.map((r) =>
            multi ? (
              <View key={r.key} style={styles.tipRow}>
                <View style={[styles.tipDot, { backgroundColor: r.color }]} />
                <Text style={styles.tipSeries} numberOfLines={1}>
                  {r.label}
                </Text>
                <Text style={styles.tipValue} numberOfLines={1}>
                  {r.text}
                </Text>
              </View>
            ) : (
              <View key={r.key} style={styles.tipSingle}>
                <Text style={styles.tipValueBig} numberOfLines={1}>
                  {r.text}
                </Text>
                <Text style={styles.tipSeries} numberOfLines={1}>
                  {r.label}
                </Text>
              </View>
            ),
          )}
        </View>
      );
    }

    const labelIdx = n >= 3 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, n - 1];

    body = (
      <>
        <View style={{ height: boxH }}>
          {geo.ticks.map((t, i) => (
            <Text
              key={i}
              pointerEvents="none"
              numberOfLines={1}
              maxFontSizeMultiplier={1.2}
              style={[styles.yLabel, { top: t.y - 7, width: geo.yW - 6 }]}
            >
              {t.text}
            </Text>
          ))}

          <View style={{ position: 'absolute', left: geo.yW, top: 0, width: geo.plotW, height }}>
            <Svg width={geo.plotW} height={height}>
              {gridLayer}
              <Defs>
                <ClipPath id={clipId}>
                  <Rect x={0} y={0} width={Math.max(0.5, progress * geo.plotW)} height={height} />
                </ClipPath>
              </Defs>
              {progress > 0 && <G clipPath={revealing ? `url(#${clipId})` : undefined}>{seriesLayer}</G>}
              {idx != null && (
                <G>
                  <Line x1={cx} x2={cx} y1={0} y2={height} stroke={colors.textMute} strokeWidth={1} opacity={0.8} />
                  {geo.lines.map((l) => (
                    <Circle key={`h${l.key}`} cx={cx} cy={l.ys[idx]} r={9} fill={l.color} opacity={0.2} />
                  ))}
                  {geo.lines.map((l) => (
                    <Circle
                      key={`d${l.key}`}
                      cx={cx}
                      cy={l.ys[idx]}
                      r={4.5}
                      fill={l.color}
                      stroke={colors.card}
                      strokeWidth={2}
                    />
                  ))}
                </G>
              )}
            </Svg>
            {tooltip}
            <View style={[styles.fill, WEB_SCRUB]} {...inputProps} />
          </View>

          {labelIdx.map((li, k) => {
            const align = k === 0 ? 'left' : k === labelIdx.length - 1 ? 'right' : 'center';
            const x = geo.yW + geo.xs[li];
            const left = align === 'left' ? x - 2 : align === 'right' ? x - 70 : x - 36;
            return (
              <Text
                key={li}
                pointerEvents="none"
                numberOfLines={1}
                maxFontSizeMultiplier={1.2}
                style={[styles.xLabel, { top: height + 6, left, textAlign: align }]}
              >
                {formatLabel(labels[li])}
              </Text>
            );
          })}
        </View>

        {multi && (
          <View style={styles.legend}>
            {series.map((s) => (
              <View key={s.key} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: s.color }]} />
                <Text style={styles.legendText} numberOfLines={1}>
                  {s.label}
                </Text>
              </View>
            ))}
          </View>
        )}
      </>
    );
  }

  return (
    <View onLayout={onLayout} accessible accessibilityRole="image" accessibilityLabel={summary} style={styles.root}>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%' },
  fill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  note: { alignItems: 'center', justifyContent: 'center' },
  noteText: { color: colors.textMute, fontSize: 13, fontWeight: '600' },

  yLabel: {
    position: 'absolute',
    left: 0,
    height: 14,
    lineHeight: 14,
    textAlign: 'right',
    color: colors.textMute,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  xLabel: {
    position: 'absolute',
    width: 72,
    height: 14,
    lineHeight: 14,
    color: colors.textMute,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },

  tip: {
    position: 'absolute',
    top: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 3,
    borderRadius: 10,
    backgroundColor: colors.cardHi,
    borderWidth: 1,
    borderColor: colors.borderHi,
  },
  tipHead: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
  tipSingle: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tipDot: { width: 8, height: 8, borderRadius: 4 },
  tipSeries: { flexShrink: 1, color: colors.textDim, fontSize: 11.5 },
  tipValue: {
    flexShrink: 0,
    marginLeft: 'auto',
    paddingLeft: 10,
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  tipValueBig: { flexShrink: 0, color: colors.text, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },

  legend: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 14, marginTop: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.textDim, fontSize: 12 },
});
