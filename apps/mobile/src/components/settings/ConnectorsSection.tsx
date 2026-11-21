import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { Animated, Platform as RNPlatform, Pressable, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, type Connection, type Platform } from '@/src/api';
import { LIVE_PLATFORMS, UPCOMING_PLATFORMS } from '@/src/platforms';
import { fmtCompact } from '@/src/format';
import { useAsync } from '@/src/hooks';
import { useSession } from '@/src/session';
import { colors, platformMeta, space, type as t } from '@/src/theme';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  PlatformBadge,
  SectionHeader,
  Skeleton,
  TextField,
  confirm,
  useToast,
} from '@/src/ui';

/** What the parent screen can call (pull to refresh / the web refresh button). */
export interface ConnectorsHandle {
  reload: () => Promise<void>;
}

type Pending = 'connect' | 'disconnect';
interface FormState {
  platform: Platform;
  handle: string;
  error: string | null;
}

const MAX_HANDLE = 60;

/** "@" + brand name, lowercased, letters/digits/_/. only: "Glow Brew Co." -> "@glowbrewco." */
export function defaultHandle(brandName: string | null | undefined): string {
  const slug = (brandName ?? '').toLowerCase().replace(/[^a-z0-9_.]/g, '');
  return `@${(slug || 'mybrand').slice(0, MAX_HANDLE - 1)}`;
}

const messageOf = (e: unknown): string => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

const upsert = (list: Connection[] | undefined, conn: Connection): Connection[] => [
  ...(list ?? []).filter((c) => c.platform !== conn.platform),
  conn,
];

const without = (list: Connection[] | undefined, platform: Platform): Connection[] =>
  (list ?? []).filter((c) => c.platform !== platform);

const isConnection = (v: unknown): v is Connection =>
  typeof v === 'object' && v !== null && typeof (v as Connection).platform === 'string' && typeof (v as Connection).status === 'string';

const followersText = (n: number): string => `${fmtCompact(n)} ${n === 1 ? 'follower' : 'followers'}`;

export function ConnectorsSection({ handleRef }: { handleRef?: Ref<ConnectorsHandle> }) {
  const { workspace } = useSession();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useAsync(() => api.listConnections(), []);
  useImperativeHandle(handleRef, () => ({ reload }), [reload]);

  const [busy, setBusy] = useState<Partial<Record<Platform, Pending>>>({});
  const [form, setForm] = useState<FormState | null>(null);

  // A platform missing from the response counts as disconnected.
  const byPlatform = useMemo(() => {
    const map = new Map<Platform, Connection>();
    for (const c of data ?? []) map.set(c.platform, c);
    return map;
  }, [data]);

  const setPending = useCallback((platform: Platform, action: Pending | null) => {
    setBusy((prev) => {
      const next = { ...prev };
      if (action) next[platform] = action;
      else delete next[platform];
      return next;
    });
  }, []);

  /** Optimistic connect. Resolves null on success, or the error message after rolling the row back. */
  const connect = async (platform: Platform, handle: string): Promise<string | null> => {
    const label = platformMeta[platform].label;
    const previous = byPlatform.get(platform) ?? null;
    setPending(platform, 'connect');
    setData((list) =>
      upsert(list, {
        platform,
        handle,
        status: 'connected',
        mode: previous?.mode ?? 'sandbox',
        followers: previous?.followers ?? 0,
        connected_at: new Date().toISOString(),
      }),
    );
    try {
      const saved = await api.connect(platform, { handle });
      if (isConnection(saved)) setData((list) => upsert(list, saved));
      else void reload();
      toast.show(`Connected ${label} (${isConnection(saved) ? saved.mode : 'sandbox'})`);
      return null;
    } catch (e) {
      setData((list) => (previous ? upsert(list, previous) : without(list, platform)));
      const message = messageOf(e);
      toast.show(message, 'error');
      return message;
    } finally {
      setPending(platform, null);
    }
  };

  const disconnect = async (conn: Connection) => {
    const { platform } = conn;
    const label = platformMeta[platform].label;
    const ok = await confirm(
      `Disconnect ${label}?`,
      `${label} will be disconnected from this workspace. You can reconnect it any time.`,
      'Disconnect',
      true,
    );
    if (!ok) return;
    setPending(platform, 'disconnect');
    setData((list) => upsert(list, { ...conn, status: 'disconnected' }));
    try {
      const saved = await api.disconnect(platform);
      if (isConnection(saved)) setData((list) => upsert(list, saved));
      else void reload();
      toast.show(`Disconnected ${label}`, 'info');
    } catch (e) {
      setData((list) => upsert(list, conn));
      toast.show(messageOf(e), 'error');
    } finally {
      setPending(platform, null);
    }
  };

  const openForm = (platform: Platform) =>
    setForm({ platform, handle: defaultHandle(workspace?.brand_name), error: null });

  const submitForm = async () => {
    if (!form) return;
    const { platform } = form;
    const handle = form.handle.replace(/\s+/g, '');
    if (handle === '' || handle === '@') {
      setForm({ ...form, handle, error: 'Enter a handle, like @yourbrand.' });
      return;
    }
    if (handle.length > MAX_HANDLE) {
      setForm({ ...form, handle, error: `Handles are ${MAX_HANDLE} characters or fewer.` });
      return;
    }
    setForm(null);
    const failure = await connect(platform, handle);
    // Re-open the form with what was typed, unless the user has already moved on to another one.
    if (failure) setForm((cur) => cur ?? { platform, handle, error: failure });
  };

  const header = (
    <SectionHeader
      title="Connectors"
      subtitle="Sandbox: simulated audience. Published posts accrue views and engagement over time."
    />
  );

  if (loading && !data) {
    return (
      <View style={styles.section}>
        {header}
        <ConnectorsSkeleton />
      </View>
    );
  }

  if (error && !data) {
    return (
      <View style={styles.section}>
        {header}
        <Card padded={false}>
          <ErrorState
            title="Couldn't load connectors"
            message={error.message}
            onRetry={() => void reload()}
          />
        </Card>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      {header}
      <Card padded={false}>
        {[...LIVE_PLATFORMS, ...UPCOMING_PLATFORMS].map((platform, index) => {
          const upcoming = !LIVE_PLATFORMS.includes(platform);
          const conn = byPlatform.get(platform) ?? null;
          const formOpen = form?.platform === platform;
          return (
            <ConnectorRow
              key={platform}
              platform={platform}
              upcoming={upcoming}
              conn={upcoming ? null : conn}
              pending={busy[platform] ?? null}
              formOpen={formOpen}
              first={index === 0}
              onConnect={() => openForm(platform)}
              onDisconnect={() => conn && void disconnect(conn)}
            >
              {formOpen && form ? (
                <ConnectForm
                  platform={platform}
                  value={form.handle}
                  error={form.error}
                  onChange={(handle) => setForm((cur) => (cur ? { ...cur, handle, error: null } : cur))}
                  onSubmit={() => void submitForm()}
                  onCancel={() => setForm(null)}
                />
              ) : null}
            </ConnectorRow>
          );
        })}
        {error ? (
          <View style={styles.note}>
            <Ionicons name="cloud-offline-outline" size={14} color={colors.textMute} />
            <Text style={[t.small, styles.noteText]}>{"Couldn't refresh. Showing the last known status."}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading connectors"
              hitSlop={10}
              onPress={() => void reload()}
            >
              <Text style={styles.retry}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
      </Card>
    </View>
  );
}

interface RowProps {
  platform: Platform;
  /** "Coming soon": a badge instead of a Connect button. */
  upcoming?: boolean;
  conn: Connection | null;
  pending: Pending | null;
  formOpen: boolean;
  first: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  children?: ReactNode;
}

function ConnectorRow({ platform, upcoming = false, conn, pending, formOpen, first, onConnect, onDisconnect, children }: RowProps) {
  const label = platformMeta[platform].label;
  const active = conn && conn.status === 'connected' ? conn : null;
  const summary = active
    ? `${label}, connected as ${active.handle}, ${followersText(active.followers)}, ${active.mode} mode`
    : `${label}, not connected`;

  const buttonTitle = pending ? '' : active ? 'Disconnect' : 'Connect';
  const buttonLabel = pending
    ? `${pending === 'connect' ? 'Connecting' : 'Disconnecting'} ${label}`
    : `${active ? 'Disconnect' : 'Connect'} ${label}`;

  return (
    <View style={[styles.rowWrap, !first && styles.divider]}>
      <View style={styles.row}>
        <View style={styles.avatar}>
          <PlatformBadge platform={platform} size={40} style={active ? undefined : styles.dimmed} />
          <View style={[styles.dot, active ? styles.dotOn : styles.dotOff]} />
        </View>

        {/* One spoken summary per row on native; on web `accessible` would add a pointless tab stop. */}
        <View style={styles.info} accessible={RNPlatform.OS !== 'web'} accessibilityLabel={summary}>
          <View style={styles.titleLine}>
            <Text style={[styles.name, !active && styles.nameOff]} numberOfLines={1}>
              {label}
            </Text>
            {upcoming ? (
              <Badge label="Coming soon" tone="neutral" style={styles.badge} />
            ) : active ? (
              active.mode === 'live' ? (
                <Badge label="live" tone="success" style={styles.badge} />
              ) : (
                <Badge label="sandbox" tone="info" style={styles.badge} />
              )
            ) : null}
          </View>
          {active ? (
            <>
              <Text style={styles.handle} numberOfLines={1}>
                {active.handle}
              </Text>
              {pending ? null : <Text style={t.small}>{followersText(active.followers)}</Text>}
            </>
          ) : upcoming ? null : (
            <Text style={styles.handleOff}>Not connected</Text>
          )}
        </View>

        {formOpen || upcoming ? null : (
          <Button
            small
            variant={pending || active ? 'secondary' : 'primary'}
            title={buttonTitle}
            accessibilityLabel={buttonLabel}
            loading={!!pending}
            onPress={active ? onDisconnect : onConnect}
            style={styles.rowButton}
          />
        )}
      </View>
      {children}
    </View>
  );
}

/** Inline "Connect {platform}" form that fades in under its row. */
function ConnectForm({
  platform,
  value,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  platform: Platform;
  value: string;
  error: string | null;
  onChange: (handle: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: RNPlatform.OS !== 'web' }).start();
  }, [opacity]);

  return (
    <Animated.View style={[styles.form, { opacity }]}>
      <TextField
        label={`${platformMeta[platform].label} handle`}
        value={value}
        onChangeText={(text) => onChange(text.replace(/\s/g, ''))}
        placeholder="@yourbrand"
        maxLength={MAX_HANDLE}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        onSubmitEditing={onSubmit}
        hint="Sandbox mode: nothing is posted to a real account."
        error={error}
      />
      <View style={styles.formActions}>
        <Button small title="Connect" icon="link-outline" onPress={onSubmit} />
        <Button small variant="ghost" title="Cancel" onPress={onCancel} />
      </View>
    </Animated.View>
  );
}

function ConnectorsSkeleton() {
  return (
    <Card padded={false}>
      {LIVE_PLATFORMS.map((platform, index) => (
        <View key={platform} style={[styles.rowWrap, index > 0 && styles.divider]}>
          <View style={styles.row}>
            <Skeleton width={40} height={40} rounded={20} />
            <View style={styles.info}>
              <Skeleton width="42%" height={14} />
              <Skeleton width="30%" height={12} />
            </View>
            <Skeleton width={104} height={36} rounded={12} />
          </View>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  rowWrap: { paddingHorizontal: space.lg, paddingVertical: space.md },
  divider: { borderTopWidth: 1, borderTopColor: colors.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56 },
  avatar: { width: 40, height: 40 },
  dimmed: { opacity: 0.5 },
  dot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.card,
  },
  dotOn: { backgroundColor: colors.success },
  dotOff: { backgroundColor: colors.textMute },
  info: { flex: 1, minWidth: 0, gap: 2 },
  titleLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm, rowGap: 2 },
  name: { fontSize: 15.5, fontWeight: '700', color: colors.text, flexShrink: 1 },
  nameOff: { color: colors.textDim },
  badge: { alignSelf: 'center' },
  handle: { fontSize: 13.5, lineHeight: 18, color: colors.textDim },
  handleOff: { fontSize: 13.5, lineHeight: 18, color: colors.textMute },
  rowButton: { minWidth: 104 },
  form: { marginTop: space.md, gap: space.md },
  formActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  noteText: { flex: 1 },
  retry: { fontSize: 13, fontWeight: '700', color: colors.accent },
});
