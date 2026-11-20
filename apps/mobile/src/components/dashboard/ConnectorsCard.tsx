import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { PLATFORMS, type Connection, type Platform } from '@/src/api';
import { fmtCompact, timeAgo } from '@/src/format';
import { colors, platformMeta, radius, space, type as t, withAlpha } from '@/src/theme';
import { Badge, Button, Card, PlatformBadge, SectionHeader, Skeleton } from '@/src/ui';
import { FEATURED_CONNECTORS, isConnected, orderConnectors, safeWebUrl, shortUrl } from './boardModel';

const GAP = space.md;
/** Card width from which the four other connectors sit in one row instead of 2 x 2. */
const FOUR_UP_AT = 560;

const openUrl = (url: string) => {
  void Linking.openURL(url).catch(() => undefined);
};

const followersText = (n: number): string => `${fmtCompact(n)} ${n === 1 ? 'follower' : 'followers'}`;

/**
 * "Social media connectors": LinkedIn and Instagram lead (profile link, connected state, last harvest, a "Real data"
 * badge when the API says the numbers are real), then the sandbox connectors. Manage them in Settings.
 */
export function ConnectorsCard({
  connections,
  loading,
  error,
  onRetry,
  style,
}: {
  connections: Connection[] | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidth((prev) => (prev === w ? prev : w));
  }, []);

  const byPlatform = useMemo(() => {
    const map = new Map<Platform, Connection>();
    for (const c of Array.isArray(connections) ? connections : []) map.set(c.platform, c);
    return map;
  }, [connections]);
  const order = orderConnectors(PLATFORMS);
  const featured = order.slice(0, FEATURED_CONNECTORS.length);
  const others = order.slice(FEATURED_CONNECTORS.length);

  const cols = width >= FOUR_UP_AT ? 4 : 2;
  const otherWidth = width > 0 ? Math.floor((width - GAP * (cols - 1)) / cols) : undefined;

  return (
    <Card style={[styles.card, style]}>
      <SectionHeader
        title="Social media connectors"
        subtitle="LinkedIn and Instagram bring real data. The rest are sandbox accounts."
        right={<Button title="Manage" variant="ghost" small onPress={() => router.push('/settings')} />}
      />
      {!connections ? (
        error && !loading ? (
          <View style={styles.message}>
            <Ionicons name="cloud-offline-outline" size={18} color={colors.danger} />
            <Text style={[t.dim, styles.messageText]}>Couldn't load connectors.</Text>
            <Button title="Retry" variant="secondary" small onPress={onRetry} />
          </View>
        ) : (
          <ConnectorsSkeleton />
        )
      ) : (
        <View style={styles.body} onLayout={onLayout}>
          <View style={styles.featuredRow}>
            {featured.map((p) => (
              <FeaturedConnector key={p} platform={p} conn={byPlatform.get(p)} />
            ))}
          </View>
          <View style={styles.othersRow}>
            {others.map((p) => (
              <OtherConnector key={p} platform={p} conn={byPlatform.get(p)} width={otherWidth} />
            ))}
          </View>
        </View>
      )}
    </Card>
  );
}

function StatusDot({ on }: { on: boolean }) {
  return (
    <View style={styles.status}>
      <View style={[styles.dot, { backgroundColor: on ? colors.success : colors.textMute }]} />
      <Text style={[styles.statusText, { color: on ? colors.success : colors.textMute }]}>
        {on ? 'Connected' : 'Not connected'}
      </Text>
    </View>
  );
}

function FeaturedConnector({ platform, conn }: { platform: Platform; conn: Connection | undefined }) {
  const meta = platformMeta[platform];
  const on = isConnected(conn);
  const url = safeWebUrl(conn?.profile_url);
  const harvested = conn?.last_harvested_at ? timeAgo(conn.last_harvested_at) : '';

  return (
    <View style={[styles.featured, { borderColor: withAlpha(meta.color, on ? 0.5 : 0.25) }]}>
      <View style={styles.featuredHead}>
        <PlatformBadge platform={platform} size={40} />
        <View style={styles.featuredTitle}>
          <Text style={t.h3} numberOfLines={1}>
            {meta.label}
          </Text>
          <View style={styles.statusRow}>
            <StatusDot on={on} />
            {on ? (
              conn?.real_data ? (
                <Badge label="Real data" tone="success" icon="shield-checkmark" />
              ) : (
                <Badge label={conn?.mode === 'live' ? 'Live' : 'Sandbox'} />
              )
            ) : null}
          </View>
        </View>
      </View>

      {conn && on ? (
        <>
          <Text style={styles.handle} numberOfLines={1}>
            {conn.handle} · {followersText(conn.followers)}
          </Text>
          {url ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Open the ${meta.label} profile`}
              hitSlop={6}
              onPress={() => openUrl(url)}
              style={({ pressed }) => [styles.link, pressed && styles.pressed]}
            >
              <Ionicons name="open-outline" size={13} color={colors.accent} />
              <Text style={styles.linkText} numberOfLines={1}>
                {shortUrl(url)}
              </Text>
            </Pressable>
          ) : null}
          {harvested ? (
            <View style={styles.harvest}>
              <Ionicons name="sync" size={12} color={colors.textMute} />
              <Text style={t.small}>{`Last harvested ${harvested}`}</Text>
            </View>
          ) : null}
        </>
      ) : (
        <View style={styles.connectRow}>
          <Text style={[t.small, styles.flex]}>Connect {meta.label} to bring in its real numbers.</Text>
          <Button title="Connect" small variant="secondary" onPress={() => router.push('/settings')} />
        </View>
      )}
    </View>
  );
}

function OtherConnector({
  platform,
  conn,
  width,
}: {
  platform: Platform;
  conn: Connection | undefined;
  width: number | undefined;
}) {
  const meta = platformMeta[platform];
  const on = isConnected(conn);
  return (
    <View style={[styles.other, width ? { width } : styles.otherFallback]}>
      <View style={styles.otherHead}>
        <PlatformBadge platform={platform} size={28} />
        <View style={styles.flex}>
          <Text style={styles.otherName} numberOfLines={1}>
            {meta.label}
          </Text>
          <Text style={t.small} numberOfLines={1}>
            {conn && on ? conn.handle : 'Not connected'}
          </Text>
        </View>
      </View>
      <View style={styles.otherFoot}>
        <View style={[styles.dot, { backgroundColor: on ? colors.success : colors.textMute }]} />
        <Text style={[t.small, styles.flex]} numberOfLines={1}>
          {conn && on ? followersText(conn.followers) : 'Connect in Settings'}
        </Text>
        {conn && on && conn.mode === 'live' ? <Badge label="Live" tone="success" /> : null}
      </View>
    </View>
  );
}

function ConnectorsSkeleton() {
  return (
    <View style={styles.body}>
      <View style={styles.featuredRow}>
        {[0, 1].map((i) => (
          <Skeleton key={i} height={112} rounded={radius.md} style={styles.featuredSkeleton} />
        ))}
      </View>
      <View style={styles.othersRow}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={64} rounded={radius.sm} style={styles.otherSkeleton} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  flex: { flex: 1, minWidth: 0 },
  body: { gap: GAP },
  featuredRow: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  featured: {
    flexGrow: 1,
    flexBasis: 220,
    minWidth: 0,
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: colors.cardHi,
  },
  featuredHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  featuredTitle: { flex: 1, minWidth: 0, gap: 2 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm, rowGap: 4 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12.5, fontWeight: '700' },
  handle: { color: colors.textDim, fontSize: 13.5, fontWeight: '600' },
  link: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 22, alignSelf: 'flex-start', maxWidth: '100%' },
  linkText: { color: colors.accent, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  harvest: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  connectRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  othersRow: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  other: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardHi,
  },
  otherFallback: { flexGrow: 1, flexBasis: 140 },
  otherHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  otherName: { color: colors.text, fontSize: 13.5, fontWeight: '700' },
  otherFoot: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  message: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.md },
  messageText: { flex: 1 },
  featuredSkeleton: { flexGrow: 1, flexBasis: 220 },
  otherSkeleton: { flexGrow: 1, flexBasis: 140 },
  pressed: { opacity: 0.8 },
});
