import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, openTrackedLink, type Post } from '@/src/api';
import { STAGE_LABEL } from '@/src/config';
import { colors, gradient, radius, space, type as t, withAlpha } from '@/src/theme';
import { Badge, Button, haptic, useToast } from '@/src/ui';
import { LiveDot, LiveNumber, useIncreaseFlash, useSettled } from './live';
import { pickLinkPost, type IconName } from './model';

type Hint = 'sent' | 'nopost';
const HINT_MS = 8000;
const BORDER = 1.5;

/**
 * The "Real people" card: clicks and onboards from real visitors on tracked links, plus the button that
 * plays visitor. The counters flash and the whole card glows when a real event lands.
 */
export function RealPeopleCard({
  clicks,
  conversions,
  context,
  filterLabel,
  linkPost,
  onFired,
}: {
  clicks: number;
  conversions: number;
  /** Changes when the data switches to another filter, so the card does not glow for it. */
  context: string;
  /** Platform the numbers are filtered to ("LinkedIn"), shown as a small badge. Omit for all platforms. */
  filterLabel?: string;
  /** Latest published post with a tracked link, if the screen already knows it (undefined: ask the API on tap). */
  linkPost: Post | undefined;
  /** Called after a click was sent, so the screen can refresh sooner than the next poll. */
  onFired: () => void;
}) {
  const toast = useToast();
  const settled = useSettled(context);
  const glow = useIncreaseFlash(clicks + conversions, settled);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<Hint | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(
    () => () => {
      alive.current = false;
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );

  const showHint = useCallback((next: Hint) => {
    setHint(next);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
  }, []);

  const fire = useCallback(
    async (post: Post) => {
      try {
        await openTrackedLink(post);
      } catch {
        toast.show('Could not open the link', 'error');
        return;
      }
      haptic.success();
      if (!alive.current) return;
      showHint('sent');
      onFired();
    },
    [toast, showHint, onFired],
  );

  const onOpen = useCallback(() => {
    if (busy) return;
    // Fast path: open inside the tap itself. Awaiting a request first would make iOS Safari block the popup.
    if (linkPost) {
      void fire(linkPost);
      return;
    }
    // Slow path: nothing cached yet, ask the API for the newest published post that has a tracked link.
    setBusy(true);
    void (async () => {
      try {
        const post = pickLinkPost(await api.listPosts({ status: 'published', limit: 10 }));
        if (!alive.current) return;
        if (!post) {
          toast.show('Publish a post first', 'info');
          showHint('nopost');
          return;
        }
        await fire(post);
      } catch (e) {
        toast.show(e instanceof ApiError ? e.message : 'Something went wrong', 'error');
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  }, [busy, linkPost, fire, toast, showHint]);

  return (
    <View style={styles.glow}>
      <LinearGradient colors={gradient.colors} start={gradient.start} end={gradient.end} style={styles.border}>
        <View style={styles.inner}>
          <View style={styles.header}>
            <LiveDot size={9} />
            <Text style={[t.h2, styles.title]}>Real people</Text>
            {filterLabel ? <Badge label={`${filterLabel} only`} /> : null}
          </View>

          <View style={styles.stats}>
            <Stat label="Clicks" icon="finger-print" color={colors.info} value={clicks} context={context} />
            <Stat label={STAGE_LABEL.conversions} icon="checkmark-circle" color={colors.success} value={conversions} context={context} />
          </View>

          <Text style={t.dim}>
            Real visitors who click your tracked links and get onboarded. Publish a post, open its link, and watch your
            click land in the funnel.
          </Text>

          {hint === 'sent' ? (
            <View style={[styles.hint, styles.hintOk]} accessibilityLiveRegion="polite">
              <Ionicons name="checkmark-circle" size={16} color={colors.success} />
              <Text style={[styles.hintText, { color: colors.success }]}>Click sent: watch it land</Text>
            </View>
          ) : null}
          {hint === 'nopost' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Publish a post first. Create a post"
              onPress={() => router.push('/create')}
              style={({ pressed }) => [styles.hint, styles.hintWarn, pressed && styles.pressed]}
            >
              <Ionicons name="information-circle" size={16} color={colors.warn} />
              <Text style={[styles.hintText, { color: colors.warn }]}>Publish a post first, then open its link here.</Text>
            </Pressable>
          ) : null}

          <Button title="Open a tracked link" icon="open-outline" full loading={busy} onPress={onOpen} />
          <Button title="Create a post" variant="ghost" small full onPress={() => router.push('/create')} />

          {/* Green wash that fades out when a real click or conversion lands. Painted last so it covers the stat tiles. */}
          <Animated.View style={[StyleSheet.absoluteFill, styles.flash, { opacity: glow, pointerEvents: 'none' }]} />
        </View>
      </LinearGradient>
    </View>
  );
}

function Stat({
  label,
  icon,
  color,
  value,
  context,
}: {
  label: string;
  icon: IconName;
  color: string;
  value: number;
  context: string;
}) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${value} real ${label.toLowerCase()}`}>
      <View style={styles.statHead}>
        <Ionicons name={icon} size={14} color={color} />
        <Text style={t.label} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <LiveNumber value={value} fromZero context={context} style={styles.statNumber} />
    </View>
  );
}

const styles = StyleSheet.create({
  glow: {
    borderRadius: radius.md,
    backgroundColor: colors.card,
    boxShadow: [{ offsetX: 0, offsetY: 6, blurRadius: 28, spreadDistance: 0, color: withAlpha(colors.accent, 0.4) }],
  },
  border: { borderRadius: radius.md, padding: BORDER },
  inner: {
    borderRadius: radius.md - BORDER,
    backgroundColor: colors.card,
    padding: space.lg,
    gap: space.md,
    overflow: 'hidden',
  },
  flash: { backgroundColor: withAlpha(colors.success, 0.2) },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  title: { flexShrink: 1, marginRight: 'auto' },
  stats: { flexDirection: 'row', gap: space.md },
  stat: { flex: 1, minWidth: 0, backgroundColor: colors.cardHi, borderRadius: 14, padding: space.md, gap: 4 },
  statHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statNumber: { color: colors.text, fontSize: 36, lineHeight: 42, fontWeight: '800', letterSpacing: -1 },
  hint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  hintOk: { backgroundColor: withAlpha(colors.success, 0.12), borderColor: withAlpha(colors.success, 0.4) },
  hintWarn: { backgroundColor: withAlpha(colors.warn, 0.12), borderColor: withAlpha(colors.warn, 0.4) },
  hintText: { flex: 1, fontSize: 13.5, fontWeight: '700' },
  pressed: { opacity: 0.85 },
});
