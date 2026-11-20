import { useEffect, useId, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Unique, SVG-id-safe prefix for one chart instance. On the web gradient and clip-path ids are
 * document-global, so two charts on a screen must never share an id.
 */
export function useUid(): string {
  return `pc${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/**
 * One-shot entrance progress, 0 -> 1 (eased). It starts the first time `active` is true and never
 * replays: the dashboard re-renders every few seconds with new numbers, and that must not restart it.
 * Driven by requestAnimationFrame, cancelled on unmount; jumps straight to 1 when the OS asks for
 * reduced motion.
 */
export function useReveal(active: boolean, durationMs: number): number {
  const [progress, setProgress] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    if (!active || done.current) return;
    let raf = 0;
    let stopped = false;
    const startedAt = Date.now();

    const finish = (): void => {
      done.current = true;
      setProgress(1);
    };
    const tick = (): void => {
      if (stopped) return;
      const t = (Date.now() - startedAt) / durationMs;
      if (t >= 1) {
        finish();
        return;
      }
      setProgress(easeOutCubic(Math.max(0, t)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    AccessibilityInfo.isReduceMotionEnabled().then(
      (reduce) => {
        if (reduce && !stopped) {
          cancelAnimationFrame(raf);
          finish();
        }
      },
      () => {},
    );

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [active, durationMs]);

  return progress;
}

/** Short eased tween of one number towards `target` (selection highlight, tooltip fade). */
export function useTween(target: number, durationMs = 160): number {
  const [value, setValue] = useState(target);
  const current = useRef(target);

  useEffect(() => {
    if (current.current === target) return;
    const from = current.current;
    const startedAt = Date.now();
    let raf = 0;
    const tick = (): void => {
      const t = Math.min(1, (Date.now() - startedAt) / durationMs);
      const v = t >= 1 ? target : from + (target - from) * easeOutCubic(t);
      current.current = v;
      setValue(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}
