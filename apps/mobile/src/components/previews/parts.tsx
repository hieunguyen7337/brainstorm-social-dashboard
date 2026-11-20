/**
 * Shared building blocks of the six platform preview cards: shell, avatar, link affordances, icon counters and a
 * handful of pure helpers. Presentational only (props in, nothing fetched). Editable text lives in `./fields`.
 */
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { fmtCompact, fmtInt } from '@/src/format';
import { colors, radius } from '@/src/theme';

import type { PreviewProps } from './types';

export type IonName = ComponentProps<typeof Ionicons>['name'];
export type PreviewStats = NonNullable<PreviewProps['stats']>;

/** Diagonal for accent gradients (top-left to bottom-right). */
export const DIAG = { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } as const;

// ---- pure helpers ---------------------------------------------------------------------------------------

export interface Identity {
  /** Display name, never empty. */
  name: string;
  /** Handle without "@", never empty. */
  plain: string;
  /** "@handle". */
  at: string;
  /** First letter of the brand, upper case. */
  initial: string;
}

/** Normalise the brand / handle pair so every card can rely on non-empty strings. */
export function identityOf(brandName: string | undefined, handle: string | undefined): Identity {
  const name = (brandName ?? '').trim() || 'Your brand';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const plain = (handle ?? '').trim().replace(/^@+/, '') || slug || 'yourbrand';
  const initial = (Array.from(name)[0] ?? '?').toUpperCase();
  return { name, plain, at: `@${plain}`, initial };
}

/** Hashtags without "#" or blanks. */
export function cleanTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? []).map((t) => String(t).replace(/^#+/, '').trim()).filter((t) => t.length > 0);
}

/** Tags the text does not already contain (so a generator that inlined them is not shown twice). */
export function tagsNotIn(tags: readonly string[], text: string): string[] {
  const lower = text.toLowerCase();
  return tags.filter((t) => {
    const needle = `#${t.toLowerCase()}`;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) return true;
      const next = lower.charAt(at + needle.length);
      if (!/[a-z0-9_]/.test(next)) return false; // whole-word hit
      from = at + 1;
    }
  });
}

/** The tracked URL never appears in the text body: it is the link card. Returns the text untouched when absent. */
export function withoutTrackedLink(text: string | undefined, link: string | null | undefined): string {
  const src = text ?? '';
  if (!link || !src.includes(link)) return src;
  return src
    .split(link)
    .join('')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "https://www.pulse.fly.dev/r/ab12" -> "pulse.fly.dev". */
export function domainOf(link: string | null | undefined): string {
  const raw = (link ?? '').trim();
  if (!raw) return '';
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(raw);
  const host = m ? m[1] : (raw.split(/[/?#]/)[0] ?? '');
  return host.replace(/^www\./i, '').toLowerCase();
}

/** "37 clicks · 1 conversion". */
export function linkStatsText(s: Pick<PreviewStats, 'clicks' | 'conversions'>): string {
  const clicks = Math.max(0, Math.round(s.clicks || 0));
  const conv = Math.max(0, Math.round(s.conversions || 0));
  return `${fmtInt(clicks)} click${clicks === 1 ? '' : 's'} · ${fmtInt(conv)} conversion${conv === 1 ? '' : 's'}`;
}

/** Screen-reader summary of the counters. */
export function statsSpeech(s: PreviewStats): string {
  return `${fmtInt(s.views)} views, ${fmtInt(s.engagements)} engagements, ${fmtInt(s.clicks)} clicks, ${fmtInt(s.conversions)} conversions`;
}

/** First non-empty line of a text (TikTok caption, previews). */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

// ---- shell ------------------------------------------------------------------------------------------------

/** Rounded 16 container with a 1px border; the parent owns the width. */
export function PreviewShell({
  background,
  borderColor,
  style,
  children,
}: {
  background: string;
  borderColor: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return <View style={[styles.shell, { backgroundColor: background, borderColor }, style]}>{children}</View>;
}

/** Brand initial on the accent -> pink gradient. */
export function Avatar({
  initial,
  size = 40,
  accent,
  shape = 'circle',
}: {
  initial: string;
  size?: number;
  accent: string;
  shape?: 'circle' | 'square';
}) {
  return (
    <LinearGradient
      colors={[accent, colors.accent2]}
      {...DIAG}
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: shape === 'circle' ? size / 2 : Math.round(size * 0.14) },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: Math.round(size * 0.44) }]}>{initial}</Text>
    </LinearGradient>
  );
}

export function Divider({ color, style }: { color: string; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, { backgroundColor: color }, style]} />;
}

/** Icon with an optional compact count; decorative (the parent row carries the accessible summary). */
export function IconCount({
  icon,
  count,
  color,
  size = 18,
  textStyle,
}: {
  icon: IonName;
  count?: number;
  color: string;
  size?: number;
  textStyle?: StyleProp<TextStyle>;
}) {
  return (
    <View style={styles.iconCount}>
      <Ionicons name={icon} size={size} color={color} />
      {count !== undefined ? <Text style={[styles.iconCountText, { color }, textStyle]}>{fmtCompact(count)}</Text> : null}
    </View>
  );
}

/** "2h · (globe)" line used by LinkedIn and Facebook headers. */
export function TimeGlobe({ label, color, size = 12 }: { label: string; color: string; size?: number }) {
  return (
    <View style={styles.timeGlobe}>
      <Text style={{ color, fontSize: size, lineHeight: size + 5 }} numberOfLines={1}>
        {label} ·
      </Text>
      <Ionicons name="globe-outline" size={size + 1} color={color} />
    </View>
  );
}

/** Small round reaction glyph (LinkedIn / Facebook reaction summary). */
export function ReactionDot({ icon, bg, ring, size = 18 }: { icon: IonName; bg: string; ring: string; size?: number }) {
  return (
    <View
      style={[
        styles.reactionDot,
        { width: size + 3, height: size + 3, borderRadius: (size + 3) / 2, backgroundColor: bg, borderColor: ring },
      ]}
    >
      <Ionicons name={icon} size={Math.round(size * 0.58)} color={colors.white} />
    </View>
  );
}

/** Inline hashtag run (nest inside the content `Text`). `lead` separates it from the text before it. */
export function HashtagSpans({
  tags,
  color,
  lead = ' ',
  weight,
}: {
  tags: readonly string[];
  color: string;
  lead?: string;
  weight?: TextStyle['fontWeight'];
}) {
  if (tags.length === 0) return null;
  return (
    <Text style={{ color, fontWeight: weight }}>
      {lead}
      {tags.map((t) => `#${t}`).join(' ')}
    </Text>
  );
}

/** "132/280", red once over the limit. */
export function CharCounter({ used, limit, color, over }: { used: number; limit: number; color: string; over: string }) {
  return (
    <Text
      style={[styles.counter, { color: used > limit ? over : color }]}
      accessibilityLabel={`${used} of ${limit} characters`}
    >
      {used}/{limit}
    </Text>
  );
}

// ---- link affordances -----------------------------------------------------------------------------------

/** Pressable only when the parent supplied `onPress`; otherwise a plain View so parent taps pass through. */
function Tappable({
  onPress,
  label,
  style,
  children,
}: {
  onPress?: () => void;
  label: string;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  if (!onPress) return <View style={style}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={label}
      style={({ pressed }) => [style, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

export interface LinkPalette {
  bg: string;
  border: string;
  text: string;
  mute: string;
  /** Call-to-action colour (text / icon). */
  cta: string;
  /** Filled call-to-action button (Facebook "Learn more"). */
  ctaBg?: string;
  ctaText?: string;
}

export interface LinkCardProps {
  link: string;
  /** Card title: the brand name. */
  title: string;
  cta: string;
  accent: string;
  palette: LinkPalette;
  /** `row`: compact tile + text (X, Reddit, compact cards). `banner`: gradient preview image + text strip. */
  variant: 'row' | 'banner';
  /** Banner only: edge to edge inside the post (no side borders or radius). */
  flush?: boolean;
  /** Banner only: show the call to action as a filled button. */
  button?: boolean;
  stats?: PreviewStats | null;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

/** The tracked link as a platform-style link card: domain, brand and "Open link"; shows click / conversion counters. */
export function LinkCard({ link, title, cta, accent, palette, variant, flush, button, stats, onPress, style }: LinkCardProps) {
  const domain = domainOf(link);
  const statsLine = stats ? linkStatsText(stats) : '';
  const label = `${cta}: ${title}${domain ? `, ${domain}` : ''}${statsLine ? `, ${statsLine}` : ''}`;
  const frame = { backgroundColor: palette.bg, borderColor: palette.border };

  if (variant === 'row') {
    return (
      <Tappable onPress={onPress} label={label} style={[styles.rowCard, frame, style]}>
        <LinearGradient colors={[accent, colors.accent2]} {...DIAG} style={styles.tile}>
          <Ionicons name="link" size={20} color={colors.white} />
        </LinearGradient>
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>
            {title}
          </Text>
          <Text style={[styles.rowSub, { color: palette.mute }]} numberOfLines={1}>
            {domain || cta}
          </Text>
          {statsLine ? (
            <Text style={[styles.rowStats, { color: palette.mute }]} numberOfLines={1}>
              {statsLine}
            </Text>
          ) : null}
        </View>
        <View style={styles.cta}>
          <Text style={[styles.ctaText, { color: palette.cta }]}>{cta}</Text>
          <Ionicons name="open-outline" size={14} color={palette.cta} />
        </View>
      </Tappable>
    );
  }

  return (
    <Tappable
      onPress={onPress}
      label={label}
      style={[styles.bannerCard, flush ? styles.flush : styles.rounded, frame, style]}
    >
      <LinearGradient colors={[accent, colors.accent2, '#ff9a3c']} {...DIAG} style={styles.banner}>
        <View style={[styles.deco, styles.decoA]} />
        <View style={[styles.deco, styles.decoB]} />
        <View style={styles.bannerBadge}>
          <Ionicons name="link" size={22} color={colors.white} />
        </View>
        <Text style={styles.bannerDomain} numberOfLines={1}>
          {domain || title}
        </Text>
      </LinearGradient>
      <View style={styles.bannerBody}>
        <View style={styles.bannerText}>
          {domain ? (
            <Text style={[styles.eyebrow, { color: palette.mute }]} numberOfLines={1}>
              {domain}
            </Text>
          ) : null}
          <Text style={[styles.bannerTitle, { color: palette.text }]} numberOfLines={2}>
            {title}
          </Text>
          {statsLine ? (
            <Text style={[styles.rowStats, { color: palette.mute }]} numberOfLines={1}>
              {statsLine}
            </Text>
          ) : null}
        </View>
        {button ? (
          <View style={[styles.button, { backgroundColor: palette.ctaBg ?? palette.border }]}>
            <Text style={[styles.buttonText, { color: palette.ctaText ?? palette.text }]}>{cta}</Text>
          </View>
        ) : (
          <View style={styles.cta}>
            <Text style={[styles.ctaText, { color: palette.cta }]}>{cta}</Text>
            <Ionicons name="open-outline" size={14} color={palette.cta} />
          </View>
        )}
      </View>
    </Tappable>
  );
}

/** "Link in bio" pill for Instagram / TikTok: the tracked link without ever printing the URL in the caption. */
export function LinkPill({
  link,
  label,
  color,
  mute,
  bg,
  border,
  stats,
  onPress,
  style,
}: {
  link: string;
  label: string;
  color: string;
  mute: string;
  bg: string;
  border: string;
  stats?: PreviewStats | null;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const domain = domainOf(link);
  const statsLine = stats ? linkStatsText(stats) : '';
  return (
    <View style={[styles.pillWrap, style]}>
      <Tappable
        onPress={onPress}
        label={`${label}${domain ? `: ${domain}` : ''}`}
        style={[styles.pill, { backgroundColor: bg, borderColor: border }]}
      >
        <Ionicons name="link" size={14} color={color} />
        <Text style={[styles.pillLabel, { color }]} numberOfLines={1}>
          {label}
        </Text>
        {domain ? (
          <Text style={[styles.pillDomain, { color: mute }]} numberOfLines={1}>
            {domain}
          </Text>
        ) : null}
      </Tappable>
      {statsLine ? (
        <Text style={[styles.pillStats, { color: mute }]} numberOfLines={1}>
          {statsLine}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { width: '100%', alignSelf: 'stretch', borderRadius: radius.md, borderWidth: 1, overflow: 'hidden' },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.white, fontWeight: '800' },
  divider: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  iconCount: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  iconCountText: { fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  timeGlobe: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  reactionDot: { alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  counter: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pressed: { opacity: 0.85 },

  // link card: row
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderWidth: 1, borderRadius: 16, overflow: 'hidden' },
  tile: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  rowTitle: { fontSize: 14.5, lineHeight: 19, fontWeight: '700' },
  rowSub: { fontSize: 12.5, lineHeight: 17 },
  rowStats: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  cta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ctaText: { fontSize: 13, fontWeight: '700' },

  // link card: banner
  bannerCard: { alignSelf: 'stretch', borderWidth: 1, overflow: 'hidden' },
  rounded: { borderRadius: 12 },
  flush: { borderRadius: 0, borderLeftWidth: 0, borderRightWidth: 0 },
  banner: {
    width: '100%',
    aspectRatio: 1.91,
    maxHeight: 210,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    overflow: 'hidden',
  },
  deco: { position: 'absolute', aspectRatio: 1, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.14)' },
  decoA: { width: '46%', top: '-30%', right: '-8%' },
  decoB: { width: '34%', bottom: '-28%', left: '-6%', backgroundColor: 'rgba(255,255,255,0.1)' },
  bannerBadge: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  bannerDomain: { color: colors.white, fontSize: 16, fontWeight: '800', letterSpacing: -0.2, maxWidth: '86%' },
  bannerBody: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  bannerText: { flex: 1, minWidth: 0, gap: 1 },
  eyebrow: { fontSize: 11.5, lineHeight: 15, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' },
  bannerTitle: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  button: { minHeight: 36, paddingHorizontal: 14, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 14, fontWeight: '700' },

  // "link in bio" pill
  pillWrap: { alignSelf: 'flex-start', maxWidth: '100%', gap: 4 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  pillLabel: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  pillDomain: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
  pillStats: { fontSize: 12, lineHeight: 16, paddingLeft: 4 },
});
