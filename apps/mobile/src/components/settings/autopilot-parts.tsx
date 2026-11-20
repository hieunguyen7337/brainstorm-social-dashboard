/** Presentational pieces of the autopilot section: pulsing status dot, "Saved" badge, skeleton, run-result card. */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';

import { colors, platformMeta, space, type as t, withAlpha } from '@/src/theme';
import type { AutopilotRun } from '@/src/types';
import { Button, Card, IconButton, PlatformBadge, Skeleton } from '@/src/ui';

const NATIVE = Platform.OS !== 'web';

/** Green dot with an expanding ring while autopilot is on; a flat grey dot when off. */
export function PulseDot({ on, size = 12 }: { on: boolean; size?: number }) {
  const wave = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!on) {
      wave.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.timing(wave, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }),
    );
    loop.start();
    return () => loop.stop();
  }, [on, wave]);

  const scale = useMemo(() => wave.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }), [wave]);
  const opacity = useMemo(() => wave.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }), [wave]);
  const box = Math.round(size * 2.4);
  const round = { width: size, height: size, borderRadius: size / 2 };

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: box, height: box, alignItems: 'center', justifyContent: 'center' }}
    >
      {on ? (
        <Animated.View
          style={[styles.ring, round, { backgroundColor: colors.success, opacity, transform: [{ scale }] }]}
        />
      ) : null}
      <View style={[round, { backgroundColor: on ? colors.success : colors.textMute }]} />
    </View>
  );
}

/** "Saved" tick that appears when `stamp` changes and fades out on its own. */
export function SavedBadge({ stamp }: { stamp: number }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!stamp) return undefined;
    opacity.stopAnimation();
    opacity.setValue(1);
    const fade = Animated.sequence([
      Animated.delay(1100),
      Animated.timing(opacity, { toValue: 0, duration: 450, useNativeDriver: NATIVE }),
    ]);
    fade.start();
    return () => fade.stop();
  }, [stamp, opacity]);

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.saved, { opacity }]}
    >
      <Ionicons name="checkmark-circle" size={15} color={colors.success} />
      <Text style={styles.savedText}>Saved</Text>
    </Animated.View>
  );
}

/** Fade + short slide-in on mount (used for the run result). */
export function Reveal({ children }: { children: ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(v, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE });
    anim.start();
    return () => anim.stop();
  }, [v]);
  const translateY = useMemo(() => v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }), [v]);
  return <Animated.View style={{ opacity: v, transform: [{ translateY }] }}>{children}</Animated.View>;
}

/** Placeholder while the config loads: hero row + two cards. */
export function AutopilotSkeleton() {
  return (
    <View style={styles.skeleton}>
      <Card>
        <View style={styles.skelHero}>
          <Skeleton width={14} height={14} rounded={7} />
          <View style={styles.skelText}>
            <Skeleton width="38%" height={16} />
            <Skeleton width="62%" height={12} />
          </View>
          <Skeleton width={52} height={30} rounded={15} />
        </View>
      </Card>
      <Card>
        <Skeleton width="30%" height={12} />
        <View style={styles.skelChips}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} width={74} height={36} rounded={18} />
          ))}
        </View>
      </Card>
      <Card>
        <Skeleton width="34%" height={12} />
        <View style={styles.skelChips}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width={96} height={36} rounded={18} />
          ))}
        </View>
      </Card>
    </View>
  );
}

export interface RunNames {
  trendTitle: string | null;
  themeName: string | null;
  themeColor: string | null;
}

export interface RunView {
  run: AutopilotRun;
  /** null while the trend and theme names are still being looked up. */
  names: RunNames | null;
  /** The approval setting when the cycle ran: decides the Queue tab if the run made no posts. */
  requireApproval: boolean;
}

/** Queue tab that holds what this run produced. */
export function queueTabFor(view: RunView): 'drafts' | 'published' {
  const posts = view.run.posts ?? [];
  if (posts.length === 0) return view.requireApproval ? 'drafts' : 'published';
  return posts.some((p) => p.status !== 'published') ? 'drafts' : 'published';
}

const postsLabel = (n: number): string => `${n} post${n === 1 ? '' : 's'}`;

function PickRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.pick}>
      <Text style={[t.label, styles.pickLabel]}>{label}</Text>
      <View style={styles.pickValue}>{children}</View>
    </View>
  );
}

/** What a manual cycle just did: how many posts, which trend and theme it picked, where they went. */
export function RunResultCard({
  view,
  onOpenQueue,
  onDismiss,
}: {
  view: RunView;
  onOpenQueue: () => void;
  onDismiss: () => void;
}) {
  const { run, names } = view;
  const posts = run.posts ?? [];
  const published = posts.filter((p) => p.status === 'published').length;
  const drafted = posts.length - published;
  const empty = posts.length === 0;

  const title = empty
    ? 'No posts this time'
    : drafted > 0 && published > 0
      ? `Drafted ${drafted}, published ${published}`
      : published > 0
        ? `Published ${postsLabel(published)}`
        : `Drafted ${postsLabel(drafted)}`;
  const subtitle = empty
    ? 'Make sure you have an active theme and at least one platform selected, then try again.'
    : drafted > 0
      ? 'Waiting in your Queue for your approval.'
      : 'Published to your connected platforms (sandbox).';

  const platforms = Array.from(new Set(posts.map((p) => p.platform)));
  const tint = empty ? colors.info : colors.success;
  const trendText = !run.trend_id ? 'No trend this time' : (names?.trendTitle ?? 'A trending topic');
  const themeText = !run.theme_id ? 'No theme this time' : (names?.themeName ?? 'One of your themes');

  return (
    <Reveal>
      <Card style={{ borderColor: withAlpha(tint, 0.4) }}>
        <View style={styles.resultHead}>
          <View style={[styles.resultIcon, { backgroundColor: withAlpha(tint, 0.16) }]}>
            <Ionicons name={empty ? 'information-circle' : 'checkmark-circle'} size={22} color={tint} />
          </View>
          <View style={styles.resultTitle}>
            <Text style={t.h3} accessibilityRole="header">
              {title}
            </Text>
            <Text style={t.small}>{subtitle}</Text>
          </View>
          <IconButton icon="close" label="Dismiss result" size={18} onPress={onDismiss} />
        </View>

        <View style={styles.picks}>
          <PickRow label="Trend">
            {names || !run.trend_id ? (
              <Text style={t.body} numberOfLines={2}>
                {trendText}
              </Text>
            ) : (
              <Skeleton width="75%" height={14} />
            )}
          </PickRow>
          <PickRow label="Theme">
            {names || !run.theme_id ? (
              <View style={styles.themeLine}>
                {names?.themeColor ? <View style={[styles.themeDot, { backgroundColor: names.themeColor }]} /> : null}
                <Text style={[t.body, styles.themeName]} numberOfLines={1}>
                  {themeText}
                </Text>
              </View>
            ) : (
              <Skeleton width="50%" height={14} />
            )}
          </PickRow>
        </View>

        {platforms.length > 0 ? (
          <View style={styles.badges}>
            {platforms.map((p) => (
              <View key={p} accessible accessibilityLabel={platformMeta[p].label}>
                <PlatformBadge platform={p} size={34} />
              </View>
            ))}
          </View>
        ) : null}

        {!empty ? (
          <View style={styles.cta}>
            <Button title="Open Queue" icon="albums-outline" variant="secondary" full onPress={onOpenQueue} />
          </View>
        ) : null}
      </Card>
    </Reveal>
  );
}

const styles = StyleSheet.create({
  ring: { position: 'absolute' },
  saved: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  savedText: { color: colors.success, fontSize: 12.5, fontWeight: '700' },
  skeleton: { gap: space.md },
  skelHero: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  skelText: { flex: 1, gap: 8 },
  skelChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: space.md },
  resultHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  resultIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  resultTitle: { flex: 1, minWidth: 0, gap: 2 },
  picks: { gap: space.sm, marginTop: space.lg },
  pick: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 24 },
  pickLabel: { width: 52 },
  pickValue: { flex: 1, minWidth: 0 },
  themeLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  themeDot: { width: 10, height: 10, borderRadius: 5 },
  themeName: { flexShrink: 1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.lg },
  cta: { marginTop: space.lg },
});
