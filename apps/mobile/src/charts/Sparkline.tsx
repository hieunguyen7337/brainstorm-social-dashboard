import { memo, useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { fmtCompact } from '@/src/format';
import { colors } from '@/src/theme';

import { areaPath, finite, monotonePath } from './path';
import type { SparklineProps } from './types';
import { useUid } from './useReveal';

/** Room for the stroke and the end dot so nothing is clipped at the edges. */
const PAD = 3;

/**
 * Tiny smooth trend line for KPI tiles: no axes, no interaction. The line is scaled to its own min and max, so
 * it shows the shape of the trend, not its size. Flat data draws a centred flat line.
 */
export const Sparkline = memo(function Sparkline({
  values,
  color = colors.accent,
  width = 80,
  height = 28,
  fill = true,
  title,
}: SparklineProps) {
  const uid = useUid();

  const geo = useMemo(() => {
    const vals = values.map((v) => Math.max(0, finite(v)));
    const n = vals.length;
    if (n === 0) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of vals) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo;
    const innerW = width - PAD * 2;
    const innerH = height - PAD * 2;
    const pts =
      n === 1
        ? [
            { x: PAD, y: height / 2 },
            { x: width - PAD, y: height / 2 },
          ]
        : vals.map((v, i) => ({
            x: PAD + (i * innerW) / (n - 1),
            y: span > 0 ? PAD + (1 - (v - lo) / span) * innerH : height / 2,
          }));
    const line = monotonePath(pts);
    const last = pts[pts.length - 1];
    return {
      line,
      area: areaPath(line, pts[0], last, height),
      last,
      first: vals[0],
      end: vals[n - 1],
      n,
    };
  }, [values, width, height]);

  let summary = `${title ?? 'Trend'}: no data`;
  if (geo) {
    const dir = geo.end > geo.first ? 'up' : geo.end < geo.first ? 'down' : 'flat';
    summary = `${title ?? 'Trend'}: ${dir}, from ${fmtCompact(geo.first)} to ${fmtCompact(geo.end)}`;
  }

  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
      style={{ width, height }}
    >
      {geo && (
        <Svg width={width} height={height}>
          {fill && (
            <>
              <Defs>
                <LinearGradient id={`${uid}-s`} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={color} stopOpacity={0.32} />
                  <Stop offset="1" stopColor={color} stopOpacity={0} />
                </LinearGradient>
              </Defs>
              <Path d={geo.area} fill={`url(#${uid}-s)`} />
            </>
          )}
          <Path
            d={geo.line}
            fill="none"
            stroke={color}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Circle cx={geo.last.x} cy={geo.last.y} r={2.2} fill={color} />
        </Svg>
      )}
    </View>
  );
});
