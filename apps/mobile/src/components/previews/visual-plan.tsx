/**
 * The "visual plan" (a post's `media_prompt`) as the hero of a card: the plan text on a gradient image panel (the
 * Instagram square, the LinkedIn 1.91:1 banner). Presentational only. Shared by `visual-frames.tsx`.
 *
 * The plan is never cut off: `fitPlan` picks the largest font whose estimated wrap fits the panel's text box, and only
 * when even the smallest size does not fit does the text box scroll. Editing reuses `PreviewText` / `AutoGrowInput`
 * from `./fields`, so the web mirror-text trick (an invisible `Text` sizes the `<textarea>`) is untouched.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { MAX_CONTENT_WIDTH } from '@/src/config';

import { fieldFont, PreviewText } from './fields';

export const PLAN_PINK = '#ff4f8b';
export const PLAN_ORANGE = '#ff9a3c';
/** Deep violet: darkens vignettes and light theme colours so white text keeps its contrast. */
const PLAN_DEEP = [26, 11, 58] as const;
/** Caret and focus ring of the plan field: the theme colour would vanish on the saturated gradient. */
const FIELD_ACCENT = '#fff1f8';
const PLACEHOLDER = 'Describe the image you want';

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---- text fitting (pure) ----------------------------------------------------------------------------------
// <fit>
/**
 * Advance widths in 1/1000 em of the ASCII glyphs ' ' (32) to '~' (126): the wider of Inter SemiBold and Arial Bold, so
 * a wrap simulated with them is never shorter than the real one on web, iOS or Android.
 */
const ADVANCE: readonly number[] = [
  278, 333, 523, 644, 650, 1004, 722, 326, 373, 373, 540, 673, 319, 465, 319, 379, 660, 556, 623, 636, 666, 629, 640,
  576, 640, 640, 333, 333, 673, 673, 673, 611, 999, 728, 722, 737, 722, 667, 611, 778, 746, 278, 580, 722, 611, 922,
  759, 778, 667, 778, 722, 667, 660, 736, 728, 1020, 720, 713, 652, 373, 379, 373, 584, 556, 351, 574, 624, 582, 624,
  591, 389, 625, 612, 278, 278, 569, 278, 900, 612, 611, 624, 624, 397, 556, 353, 612, 587, 839, 569, 588, 566, 455,
  359, 455, 673,
];
const SAFETY = 1.03;
const LINE_RATIO = 1.3;
/** Share of the text box a fitted plan may fill: the rest is breathing room. */
const FILL = 0.94;

/** Width of one code point in em (approximate for anything outside ASCII). */
function emWidth(code: number): number {
  if (code >= 32 && code <= 126) return ((ADVANCE[code - 32] ?? 600) * SAFETY) / 1000;
  if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0; // joiner / variation selector
  if (code >= 0x2e80 && code < 0xa000) return 1; // CJK
  if (code >= 0x1f000 || (code >= 0x2600 && code <= 0x27bf)) return 1.2; // emoji and symbols
  return 0.62; // accented Latin, curly quotes, dashes, other scripts
}

/** Lines `text` wraps to in a box `width` px wide: greedy word wrap, long words break by character. */
export function countLines(text: string, width: number, fontSize: number): number {
  const space = emWidth(32) * fontSize;
  let lines = 0;
  for (const para of text.replace(/\r/g, '').split('\n')) {
    let n = 1;
    let cur = 0;
    for (const word of para.split(' ')) {
      let w = 0;
      for (const ch of word) w += emWidth(ch.codePointAt(0) ?? 32);
      w *= fontSize;
      if (cur > 0 && cur + space + w <= width) {
        cur += space + w;
      } else if (cur === 0 && w <= width) {
        cur = w;
      } else {
        if (cur > 0) {
          n += 1;
          cur = 0;
        }
        if (w > width) {
          const full = Math.floor(w / width);
          n += full;
          cur = w - full * width;
        } else {
          cur = w;
        }
      }
    }
    lines += n;
  }
  return lines;
}

export interface PlanFit {
  fontSize: number;
  lineHeight: number;
  /** Estimated line count at that size. */
  lines: number;
  /** Even the smallest size needs more room than the box has: the box scrolls (or clamps, on compact cards). */
  overflow: boolean;
}

/** Largest integer font size in [minSize, maxSize] whose wrapped text fits `width` x `height`. */
export function fitPlan(text: string, width: number, height: number, maxSize: number, minSize: number): PlanFit {
  const hi = Math.max(1, Math.floor(maxSize));
  const lo = Math.max(1, Math.min(hi, Math.floor(minSize)));
  const room = Math.max(0, height) * FILL;
  const w = Math.max(24, width);
  for (let size = hi; size >= lo; size -= 1) {
    const lineHeight = Math.round(size * LINE_RATIO);
    const lines = countLines(text, w, size);
    if (lines * lineHeight <= room) return { fontSize: size, lineHeight, lines, overflow: false };
  }
  return { fontSize: lo, lineHeight: Math.round(lo * LINE_RATIO), lines: countLines(text, w, lo), overflow: true };
}
// </fit>

/**
 * Pulls light theme colours (mint, amber, sky) towards deep violet so white text on the gradient stays readable. The
 * default violet and the other dark swatches come back unchanged.
 */
export function deepen(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
  if (lum <= 0.24) return hex;
  const t = Math.min(0.62, (lum - 0.24) * 1.5);
  const mixed = rgb.map((v, i) => Math.round(v * (1 - t) + (PLAN_DEEP[i] ?? 0) * t));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// ---- measurement ------------------------------------------------------------------------------------------

/**
 * Width of the panel, from its first layout. Until then the card is assumed to span the screen minus the 16px page
 * gutters (capped at the content column), which is right on phones, so the first frame is already close.
 */
export function useSide(): [number, (e: LayoutChangeEvent) => void] {
  const { width: screen } = useWindowDimensions();
  const [side, setSide] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const next = Math.round(e.nativeEvent.layout.width);
    setSide((cur) => (cur === next ? cur : next));
  }, []);
  return [side > 0 ? side : Math.max(240, Math.min(screen - 34, MAX_CONTENT_WIDTH - 2)), onLayout];
}

// ---- pieces -----------------------------------------------------------------------------------------------

/** Height of the label / counter pills. */
export const PILL_H = 26;

/** Translucent dark pill that stays legible on any part of the gradient. */
export function Pill({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.pill, style]}>{children}</View>;
}

/** "VISUAL PLAN" label with an image icon; a pencil joins it while the plan can be edited (the edit hint). */
export function PlanLabel({ editable }: { editable: boolean }) {
  return (
    <Pill>
      <Ionicons name="image-outline" size={13} color="#ffffff" />
      <Text style={styles.pillLabel}>Visual plan</Text>
      {editable ? (
        <View style={styles.pencil}>
          <Ionicons name="create-outline" size={12} color="#ffffff" />
        </View>
      ) : null}
    </Pill>
  );
}

/** Web-only CSS that `ViewStyle` has no key for. */
function webCss(css: Record<string, string | number>): ViewStyle {
  return Platform.OS === 'web' ? (css as unknown as ViewStyle) : {};
}

const WEB_SCROLLBAR = webCss({ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255, 255, 255, 0.55) transparent' });

/** How far the edit plate (and the focus ring of the field inside it) bleeds beyond the text box. */
const PLATE_X = 12;
const PLATE_Y = 8;

export interface PlanTextProps {
  value: string;
  editable: boolean;
  onChangeText?: (text: string) => void;
  /** The text box in px; the edit plate bleeds a few px beyond it. */
  width: number;
  height: number;
  maxSize: number;
  minSize: number;
  /** Compact cards: clamp with an ellipsis instead of scrolling. */
  clamp?: boolean;
  testID?: string;
}

/**
 * The plan text, fitted to its box. Read-only it is a selectable `Text`; editable it is the shared `AutoGrowInput`
 * on a glass plate. A scroll view with a hard `maxHeight` holds it, so text that still does not fit at the smallest
 * size scrolls inside the panel instead of being cut off.
 */
export function PlanText({
  value,
  editable,
  onChangeText,
  width,
  height,
  maxSize,
  minSize,
  clamp: clampLines = false,
  testID,
}: PlanTextProps) {
  // iOS Safari zooms into inputs under 16px: `fieldFont` raises them, so an editable plan never fits below that.
  const floor = editable ? Math.max(minSize, fieldFont({ fontSize: 1 }).fontSize ?? 1) : minSize;
  const fit = useMemo(
    () => fitPlan(value, width, height, Math.max(maxSize, floor), floor),
    [value, width, height, maxSize, floor],
  );
  const textStyle = useMemo<TextStyle>(
    () => ({
      color: '#ffffff',
      fontSize: fit.fontSize,
      lineHeight: fit.lineHeight,
      fontWeight: '600',
      letterSpacing: -0.15,
      textShadowColor: 'rgba(40, 10, 70, 0.3)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 8,
    }),
    [fit.fontSize, fit.lineHeight],
  );
  const maxLines = clampLines ? Math.max(1, Math.floor(height / fit.lineHeight)) : undefined;

  return (
    <ScrollView
      testID={testID}
      style={[styles.scroll, { maxHeight: height + 2 * PLATE_Y }, WEB_SCROLLBAR]}
      contentContainerStyle={[styles.plate, editable && styles.plateOn]}
      bounces={false}
      alwaysBounceVertical={false}
      overScrollMode="never"
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      indicatorStyle="white"
    >
      <PreviewText
        value={value}
        editable={editable}
        onChangeText={onChangeText}
        placeholder={PLACEHOLDER}
        style={textStyle}
        mutedColor="rgba(255, 255, 255, 0.62)"
        accent={FIELD_ACCENT}
        label="Visual plan"
        maxLines={maxLines}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    height: PILL_H,
    paddingHorizontal: 10,
    borderRadius: PILL_H / 2,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    backgroundColor: 'rgba(26, 11, 58, 0.4)',
  },
  pillLabel: {
    color: '#ffffff',
    fontSize: 10.5,
    lineHeight: 14,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  pencil: {
    width: 18,
    height: 18,
    marginRight: -4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.24)',
  },

  // The scroll view is PLATE px larger than the text box on every side and its content is padded back in, so the
  // text sits exactly where a plain `Text` would, and the plate / focus ring have room to draw.
  scroll: { flexGrow: 0, flexShrink: 1, marginHorizontal: -PLATE_X, marginVertical: -PLATE_Y },
  plate: {
    paddingHorizontal: PLATE_X - 1,
    paddingVertical: PLATE_Y - 1,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: 14,
  },
  plateOn: { backgroundColor: 'rgba(255, 255, 255, 0.1)', borderColor: 'rgba(255, 255, 255, 0.28)' },
});
