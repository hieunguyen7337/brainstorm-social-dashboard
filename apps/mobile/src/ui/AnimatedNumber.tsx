import { useEffect, useRef, useState } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';

import { colors } from '@/src/theme';
import { fmtInt } from '@/src/format';
import { easeOutCubic } from './utils';

/**
 * Number that tweens to its new value (count-up) and flashes green while it grows, so live counters
 * visibly tick when the 5 s poll brings new data.
 */
export function AnimatedNumber({
  value,
  format = fmtInt,
  style,
  duration = 700,
  fromZero = false,
  flash = true,
}: {
  value: number;
  format?: (n: number) => string;
  style?: StyleProp<TextStyle>;
  duration?: number;
  /** Count up from 0 on first mount (hero numbers). Default: show the value immediately. */
  fromZero?: boolean;
  /** Tint the number green for a moment when it increases. Default true. */
  flash?: boolean;
}) {
  const [shown, setShown] = useState(fromZero ? 0 : value);
  const [flashing, setFlashing] = useState(false);
  const current = useRef(fromZero ? 0 : value);
  const raf = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const from = current.current;
    if (from === value) return;
    if (flash && value > from) {
      setFlashing(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashing(false), 1100);
    }
    const start = Date.now();
    const tick = () => {
      const p = Math.min(1, (Date.now() - start) / duration);
      const next = from + (value - from) * easeOutCubic(p);
      current.current = next;
      setShown(next);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else current.current = value;
    };
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value, duration, flash]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  return (
    <Text style={[{ fontVariant: ['tabular-nums'] }, style, flashing && { color: colors.success }]}>
      {format(Math.round(shown))}
    </Text>
  );
}
