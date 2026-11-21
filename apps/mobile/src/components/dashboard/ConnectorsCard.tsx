import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { type Connection, type HarvestStatus, type Platform } from '@/src/api';
import { useConnectSheet } from '@/src/components/connect/ConnectSheet';
import { followersLabel, latestIso, updatedLabel } from '@/src/connect';
import { fmtCompact, timeAgo } from '@/src/format';
import { colors, platformMeta, radius, space, type as t, withAlpha } from '@/src/theme';
import { Badge, Button, Card, PlatformBadge, SectionHeader, Skeleton } from '@/src/ui';
import { LIVE_PLATFORMS } from '@/src/platforms';
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
 *
 * In a real workspace (`real`, docs/REAL.md) every platform is one the person fills in themselves: a connected one shows its
 * handle, followers, a "Real" badge and when it was last updated, with an "Update" button; the others say "Not connected"
 * with a "Connect" button. Both open the connect dialog, never Settings.
 */
export function ConnectorsCard({
  connections,
  loading,
  error,
  onRetry,
  style,
  real = false,
  demo = false,
  harvest,
}: {
  connections: Connection[] | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  style?: StyleProp<ViewStyle>;
  /** A workspace that works from connected accounts (real or demo): the connect dialog instead of Settings. */
  real?: boolean;
  /** The demo workspace (docs/REAL.md): same layout as `real`, but the badges say "Demo" and the numbers are synthetic. */
  demo?: boolean;
  /** `GET /api/connections/harvest-status`, best effort: its "last saved" time makes "Updated ..." exact. */
  harvest?: HarvestStatus[];
}) {
  const { open } = useConnectSheet();
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
  const harvestBy = useMemo(() => {
    const map = new Map<Platform, HarvestStatus>();
    for (const h of Array.isArray(harvest) ? harvest : []) map.set(h.platform, h);
    return map;
  }, [harvest]);
  const order = orderConnectors(LIVE_PLATFORMS);
  const featured = order.slice(0, FEATURED_CONNECTORS.length);
  const others = order.slice(FEATURED_CONNECTORS.length);

  const cols = width >= FOUR_UP_AT ? 4 : 2;
  const otherWidth = width > 0 ? Math.floor((width - GAP * (cols - 1)) / cols) : undefined;

  return (
    <Card style={[styles.card, style]}>
      <SectionHeader
        title="Social media connectors"
        subtitle={
          demo
            ? 'Demo accounts with synthetic numbers.'
            : real
              ? 'Your real numbers, from screenshots or typed in.'
              : 'LinkedIn and Instagram bring real data. The rest are sandbox accounts.'
        }
        right={
          <Button
            title="Manage"
            variant="ghost"
            small
            onPress={real ? () => open() : () => router.push('/settings')}
          />
        }
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
            {featured.map((p) =>
              real ? (
                <RealFeaturedConnector
                  key={p}
                  platform={p}
                  conn={byPlatform.get(p)}
                  harvest={harvestBy.get(p)}
                  demo={demo}
                  onOpen={open}
                />
              ) : (
                <FeaturedConnector key={p} platform={p} conn={byPlatform.get(p)} />
              ),
            )}
          </View>
          <View style={styles.othersRow}>
            {others.map((p) =>
              real ? (
                <RealOtherConnector
                  key={p}
                  platform={p}
                  conn={byPlatform.get(p)}
                  harvest={harvestBy.get(p)}
                  width={otherWidth}
                  demo={demo}
                  onOpen={open}
                />
              ) : (
                <OtherConnector key={p} platform={p} conn={byPlatform.get(p)} width={otherWidth} />
              ),
            )}
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

// ---- real workspace ---------------------------------------------------------------------------------

/** "hieu73372025 · 46 followers"; a count of 0 is left out (a typed set of numbers need not include followers). */
function detailLine(conn: Connection): string {
  const parts = [conn.handle.trim(), conn.followers > 0 ? followersLabel(conn.followers, fmtCompact) : ''];
  return parts.filter(Boolean).join(' · ');
}

/** "Updated 3h ago", from the newest of the harvest status and the connection's own times. */
const updatedOf = (conn: Connection, harvest: HarvestStatus | undefined): string | null =>
  updatedLabel(latestIso(harvest?.last_harvest_at, conn.last_harvested_at, conn.connected_at));

/** "Real" for a real workspace, "Demo" for the demo workspace's synthetic numbers. */
function SourceBadge({ demo }: { demo: boolean }) {
  return demo ? <Badge label="Demo" tone="warn" icon="flask-outline" /> : <Badge label="Real" tone="success" icon="shield-checkmark" />;
}

function RealFeaturedConnector({
  platform,
  conn,
  harvest,
  demo,
  onOpen,
}: {
  platform: Platform;
  conn: Connection | undefined;
  harvest: HarvestStatus | undefined;
  demo: boolean;
  onOpen: (platform: Platform) => void;
}) {
  const meta = platformMeta[platform];
  const connected = conn && isConnected(conn) ? conn : null;
  const detail = connected ? detailLine(connected) : '';
  const updated = connected ? updatedOf(connected, harvest) : null;

  return (
    <View style={[styles.featured, { borderColor: withAlpha(meta.color, connected ? 0.5 : 0.25) }]}>
      <View style={styles.featuredHead}>
        <PlatformBadge platform={platform} size={40} />
        <View style={styles.featuredTitle}>
          <Text style={t.h3} numberOfLines={1}>
            {meta.label}
          </Text>
          <View style={styles.statusRow}>
            <StatusDot on={!!connected} />
            {connected ? <SourceBadge demo={demo} /> : null}
          </View>
        </View>
      </View>

      {connected ? (
        <>
          {detail ? (
            <Text style={styles.handle} numberOfLines={1}>
              {detail}
            </Text>
          ) : null}
          {updated ? (
            <View style={styles.harvest}>
              <Ionicons name="sync" size={12} color={colors.textMute} />
              <Text style={t.small}>{updated}</Text>
            </View>
          ) : null}
          <Button
            title="Update"
            accessibilityLabel={`Update ${meta.label}`}
            small
            variant="secondary"
            style={styles.action}
            onPress={() => onOpen(platform)}
          />
        </>
      ) : (
        <Button
          title="Connect"
          accessibilityLabel={`Connect ${meta.label}`}
          small
          variant="secondary"
          style={styles.action}
          onPress={() => onOpen(platform)}
        />
      )}
    </View>
  );
}

function RealOtherConnector({
  platform,
  conn,
  harvest,
  width,
  demo,
  onOpen,
}: {
  platform: Platform;
  conn: Connection | undefined;
  harvest: HarvestStatus | undefined;
  width: number | undefined;
  demo: boolean;
  onOpen: (platform: Platform) => void;
}) {
  const meta = platformMeta[platform];
  const connected = conn && isConnected(conn) ? conn : null;
  const handle = connected?.handle.trim() ?? '';
  const updated = connected ? updatedOf(connected, harvest) : null;

  return (
    <View style={[styles.other, width ? { width } : styles.otherFallback]}>
      <View style={styles.otherHead}>
        <PlatformBadge platform={platform} size={28} />
        <View style={styles.flex}>
          <Text style={styles.otherName} numberOfLines={1}>
            {meta.label}
          </Text>
          <Text style={t.small} numberOfLines={1}>
            {connected ? handle || 'Connected' : 'Not connected'}
          </Text>
        </View>
      </View>
      {connected ? (
        <View style={styles.otherMeta}>
          {connected.followers > 0 ? (
            <Text style={t.small} numberOfLines={1}>
              {followersLabel(connected.followers, fmtCompact)}
            </Text>
          ) : null}
          <SourceBadge demo={demo} />
          {updated ? (
            <Text style={[t.small, styles.metaFull]} numberOfLines={1}>
              {updated}
            </Text>
          ) : null}
        </View>
      ) : null}
      <Button
        title={connected ? 'Update' : 'Connect'}
        accessibilityLabel={`${connected ? 'Update' : 'Connect'} ${meta.label}`}
        small
        variant="secondary"
        full
        style={styles.pushDown}
        onPress={() => onOpen(platform)}
      />
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
  otherMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm, rowGap: 4 },
  metaFull: { flexBasis: '100%' },
  // Tiles in a row share a height: the button sits at the bottom of each, whatever its content wraps to.
  action: { alignSelf: 'flex-start', marginTop: 'auto' },
  pushDown: { marginTop: 'auto' },
  message: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.md },
  messageText: { flex: 1 },
  featuredSkeleton: { flexGrow: 1, flexBasis: 220 },
  otherSkeleton: { flexGrow: 1, flexBasis: 140 },
  pressed: { opacity: 0.8 },
});
