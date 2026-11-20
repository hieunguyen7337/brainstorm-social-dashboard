import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { api, ApiError, getToken, type RoomInfo } from '@/src/api';
import { colors, gradient, radius, space, type as t, withAlpha } from '@/src/theme';
import { copyText, haptic, useToast } from '@/src/ui';
import { getLastRoom, setLastRoom } from './roomStore';

type IconName = ComponentProps<typeof Ionicons>['name'];

const NOT_AVAILABLE = 'Rooms are not available yet, try again in a minute';
const GENERIC_FAILURE = "Couldn't start a room. Please try again in a minute.";

/** `url` with `token=<session token>` appended (`&` when it already has a query, before any `#fragment`). */
export function withToken(url: string, token: string | null): string {
  if (!token) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}${hash}`;
}

/** A missing endpoint (API not deployed yet), an unreachable server or a server hiccup is "not yet", never an error. */
function friendlyMessage(e: unknown): string {
  if (e instanceof ApiError && (e.status === 404 || e.status === 0 || e.status >= 500)) return NOT_AVAILABLE;
  return GENERIC_FAILURE;
}

/**
 * Open a blank tab right now, inside the tap. iOS Safari blocks a popup that is opened after an awaited request, so the
 * tab is opened first and pointed at the big screen once the room exists. Returns null on native or when blocked.
 */
function openBlankTab(): Window | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    const w = window.open('', '_blank');
    if (!w) return null;
    try {
      w.opener = null; // the big screen never needs a handle back to this page
      w.document.title = 'Starting room';
      w.document.body.style.cssText =
        'margin:0;background:#0b1020;color:#a8b0cf;font:16px -apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh';
      w.document.body.textContent = 'Starting your room...';
    } catch {
      // a placeholder is a nicety only
    }
    return w;
  } catch {
    return null;
  }
}

/** Open the big screen in a new tab (web) or the system browser (native). Must be called inside a tap on web. */
function openScreen(url: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    try {
      return Promise.resolve(typeof window !== 'undefined' && window.open(url, '_blank') !== null);
    } catch {
      return Promise.resolve(false);
    }
  }
  return Linking.openURL(url).then(
    () => true,
    () => false,
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (await copyText(text)) return true; // expo-clipboard, with its own legacy fallback on web
  try {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Start a room": creates a room, opens its big screen (with this workspace's token) in a new tab, and shows the join link
 * phones in the room open (the QR target) with a Copy button. `compact` is the slimmer variant (no caption) inside the wide
 * board's Generate column.
 */
export function StartRoom({ compact, style }: { compact?: boolean; style?: StyleProp<ViewStyle> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [room, setRoom] = useState<RoomInfo | null>(getLastRoom);
  const [note, setNote] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const requesting = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = () => {
    if (requesting.current) return;
    requesting.current = true;
    setBusy(true);
    setNote(null);
    setBlocked(false);
    haptic.tap();
    // Synchronous, inside the tap (see openBlankTab).
    const tab = openBlankTab();

    void (async () => {
      try {
        const info = await api.createRoom();
        setLastRoom(info);
        if (!alive.current) {
          tab?.close();
          return;
        }
        setRoom(info);
        const url = withToken(info.screen_url, getToken());
        if (Platform.OS === 'web') {
          if (tab && !tab.closed) tab.location.href = url;
          else setBlocked(true);
        } else if (!(await openScreen(url))) {
          setBlocked(true);
        }
        haptic.success();
        toast.show('Room ready: share the link');
      } catch (e) {
        tab?.close();
        if (!alive.current) return;
        setNote(friendlyMessage(e));
        haptic.warn();
      } finally {
        requesting.current = false;
        if (alive.current) setBusy(false);
      }
    })();
  };

  const copy = useCallback(async () => {
    if (!room) return;
    const ok = await copyToClipboard(room.join_url);
    toast.show(ok ? 'Join link copied' : "Couldn't copy the link", ok ? 'success' : 'error');
  }, [room, toast]);

  const reopen = () => {
    if (!room) return;
    void openScreen(withToken(room.screen_url, getToken())).then((ok) => {
      if (!ok && alive.current) setBlocked(true);
    });
  };

  return (
    <View style={[styles.wrap, style]}>
      <Pressable
        testID="start-room"
        accessibilityRole="button"
        accessibilityLabel="Start a room"
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={start}
        style={({ pressed }) => [busy && styles.busy, pressed && styles.pressed]}
      >
        <LinearGradient
          colors={gradient.colors}
          start={gradient.start}
          end={gradient.end}
          style={[styles.button, compact && styles.buttonCompact]}
        >
          {busy ? <ActivityIndicator size="small" color={colors.white} /> : <Ionicons name="people" size={20} color={colors.white} />}
          <Text style={styles.buttonLabel} numberOfLines={1}>
            {busy ? 'Starting room...' : 'Start a room'}
          </Text>
        </LinearGradient>
      </Pressable>

      {note ? (
        <View testID="start-room-note" style={styles.note} accessibilityRole="alert">
          <Ionicons name="information-circle-outline" size={16} color={colors.info} />
          <Text style={styles.noteText}>{note}</Text>
        </View>
      ) : null}

      {room ? (
        <View testID="room-card" style={styles.card}>
          <View style={styles.cardHead}>
            <Ionicons name="qr-code-outline" size={16} color={colors.accent} />
            <Text style={[t.label, styles.cardLabel]} numberOfLines={1}>{`Room ${room.code}`}</Text>
          </View>
          <Text testID="room-join-url" selectable style={styles.url}>
            {room.join_url}
          </Text>
          {blocked ? (
            <Text style={t.small}>Your browser did not open the big screen. Tap Open big screen to show it.</Text>
          ) : null}
          <View style={styles.actions}>
            <SmallAction testID="room-copy" icon="copy-outline" label="Copy" onPress={() => void copy()} />
            <SmallAction
              testID="room-open-screen"
              icon="tv-outline"
              label="Open big screen"
              tone={blocked ? 'primary' : 'plain'}
              onPress={reopen}
            />
          </View>
        </View>
      ) : (
        !note && !compact && (
          <Text style={styles.caption}>Put everyone in the room on a big screen. One scan and they are in.</Text>
        )
      )}
    </View>
  );
}

function SmallAction({
  testID,
  icon,
  label,
  onPress,
  tone = 'plain',
}: {
  testID: string;
  icon: IconName;
  label: string;
  onPress: () => void;
  tone?: 'plain' | 'primary';
}) {
  const primary = tone === 'primary';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={({ pressed }) => [styles.action, primary && styles.actionPrimary, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={16} color={primary ? colors.white : colors.text} />
      <Text style={[styles.actionLabel, primary && { color: colors.white }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  button: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 18,
    borderRadius: radius.md,
  },
  buttonCompact: { minHeight: 46 },
  buttonLabel: { color: colors.white, fontSize: 16.5, fontWeight: '800', letterSpacing: 0.1 },
  busy: { opacity: 0.8 },
  pressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  caption: { ...t.small, textAlign: 'center' },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 8,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: withAlpha(colors.info, 0.1),
    borderWidth: 1,
    borderColor: withAlpha(colors.info, 0.3),
  },
  noteText: { flex: 1, minWidth: 0, color: colors.textDim, fontSize: 13, lineHeight: 18, fontWeight: '500' },
  card: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.cardHi,
    borderWidth: 1,
    borderColor: colors.borderHi,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardLabel: { flex: 1, minWidth: 0 },
  url: { ...t.mono, color: colors.text, fontSize: 12.5, lineHeight: 17 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  action: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderHi,
  },
  actionPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  actionLabel: { color: colors.text, fontSize: 13.5, fontWeight: '700' },
});
