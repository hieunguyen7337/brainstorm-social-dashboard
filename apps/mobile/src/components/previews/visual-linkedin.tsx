/**
 * LinkedIn-only pieces next to the visual-plan banner:
 *  - `LinkStrip`: the tracked link as the caption strip of the banner (domain, brand, click counters, "Open link").
 *  - `Collapsible`: the post text cut after a few lines with a LinkedIn-style "…see more" tail.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { withAlpha } from '@/src/theme';

import { domainOf, linkStatsText, type LinkPalette, type PreviewStats } from './parts';

export interface LinkStripProps {
  link: string;
  /** The brand name. */
  title: string;
  stats?: PreviewStats | null;
  palette: LinkPalette;
  /** Without it the strip is display-only and never swallows taps meant for the parent. */
  onPress?: () => void;
}

/** Edge-to-edge strip under the banner: the banner is the link's "image", this is its caption. */
export function LinkStrip({ link, title, stats, palette, onPress }: LinkStripProps) {
  const domain = domainOf(link);
  const statsLine = stats ? linkStatsText(stats) : '';
  const label = `Open link: ${title}${domain ? `, ${domain}` : ''}${statsLine ? `, ${statsLine}` : ''}`;
  const frame = { backgroundColor: palette.bg, borderColor: palette.border };
  const body = (
    <>
      <View style={styles.stripText}>
        {domain ? (
          <Text style={[styles.eyebrow, { color: palette.mute }]} numberOfLines={1}>
            {domain}
          </Text>
        ) : null}
        <Text style={[styles.stripTitle, { color: palette.text }]} numberOfLines={1}>
          {title}
        </Text>
        {statsLine ? (
          <Text style={[styles.stripStats, { color: palette.mute }]} numberOfLines={1}>
            {statsLine}
          </Text>
        ) : null}
      </View>
      <View style={styles.cta}>
        <Text style={[styles.ctaText, { color: palette.cta }]}>Open link</Text>
        <Ionicons name="open-outline" size={14} color={palette.cta} />
      </View>
    </>
  );

  if (!onPress) return <View style={[styles.strip, frame]}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.strip, frame, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

export interface CollapsibleProps {
  /** Lines shown before the "…see more" tail. */
  lines: number;
  /** Line height of the text inside, in px, so the cut always lands between two lines. */
  lineHeight: number;
  /** Tapping "…see more" expands in place. Off for list cards, where taps belong to the parent. */
  interactive: boolean;
  /** Card background as a 6-digit hex: the tail fades into it. */
  background: string;
  /** Colour of the "…see more" text. */
  color: string;
  children: ReactNode;
}

/**
 * Clips its children to `lines` lines and, only if they are really taller than that, lays "…see more" over the end
 * of the last visible line (the text beneath the tail fades out, as on LinkedIn). The clip is a plain `maxHeight`
 * with `overflow: hidden`; the real height comes from `onLayout` of an inner view, so it is exact on web and native,
 * and there is no flash of an ellipsis on text that fits.
 */
export function Collapsible({ lines, lineHeight, interactive, background, color, children }: CollapsibleProps) {
  const [open, setOpen] = useState(false);
  const [natural, setNatural] = useState(0);
  const limit = lines * lineHeight;
  const cut = !open && natural > limit + 1;
  const onLayout = useCallback((e: LayoutChangeEvent) => setNatural(Math.round(e.nativeEvent.layout.height)), []);

  const tail = (
    <>
      <LinearGradient
        colors={[withAlpha(background, 0), background]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={[styles.fade, { height: lineHeight }]}
      />
      <View style={[styles.tail, { height: lineHeight, backgroundColor: background }]}>
        <Text style={[styles.tailText, { color, lineHeight }]}>{'…see more'}</Text>
      </View>
    </>
  );

  return (
    <View>
      <View style={open ? undefined : { maxHeight: limit, overflow: 'hidden' }}>
        <View onLayout={onLayout}>{children}</View>
      </View>
      {cut ? (
        interactive ? (
          <Pressable
            testID="linkedin-see-more"
            onPress={() => setOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="See more"
            // The tail is one text line tall: the slop brings the tap target to 40px.
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 6 }}
            style={({ pressed }) => [styles.more, pressed && styles.pressed]}
          >
            {tail}
          </Pressable>
        ) : (
          <View style={styles.more} aria-hidden>
            {tail}
          </View>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
    // Top edge only: the strip's own background separates it from what follows, and a bottom border would sit
    // right against the card's inset divider as a double line.
    borderTopWidth: 1,
  },
  pressed: { opacity: 0.85 },
  stripText: { flex: 1, minWidth: 0, gap: 1 },
  eyebrow: { fontSize: 11.5, lineHeight: 15, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' },
  stripTitle: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  stripStats: { fontSize: 12, lineHeight: 16 },
  cta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ctaText: { fontSize: 13, fontWeight: '700' },

  // The tail sits on the last visible line, flush right: a short fade, then an opaque patch with the label.
  more: { position: 'absolute', right: 0, bottom: 0, flexDirection: 'row' },
  fade: { width: 28 },
  tail: { justifyContent: 'center', paddingLeft: 2 },
  tailText: { fontSize: 14, fontWeight: '600' },
});
