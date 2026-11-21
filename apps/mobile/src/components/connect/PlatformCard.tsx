/**
 * One platform in "Connect your real accounts": name, where to take the screenshot, "Upload a screenshot"; on Android
 * with the in-app reader available, "Connect with <Platform>" (sign in inside Pulse, `src/autoRead`) is the primary action
 * and the screenshot upload the fallback. Once connected: handle, followers, a "Real" badge, "Updated <time>" and
 * "Update". The numbers form (or the "Claude is reading" state) opens inside the card as `children`.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Platform as RNPlatform, StyleSheet, Text, View } from 'react-native';

import { followersLabel, PLATFORM_HELP } from '@/src/connect';
import { fmtCompact } from '@/src/format';
import { colors, platformMeta, space, type as t, withAlpha } from '@/src/theme';
import type { Connection, Platform } from '@/src/types';
import { Badge, Button, Card, PlatformBadge } from '@/src/ui';

export type CardNote = { tone: 'success' | 'info' | 'error'; text: string };

const NOTE_COLOR = { success: colors.success, info: colors.info, error: colors.danger } as const;

export interface PlatformCardProps {
  platform: Platform;
  /** The saved connection; only a `connected` one counts as connected. */
  conn: Connection | null;
  /** "Updated 3h ago", or null when no time is known. */
  updated: string | null;
  /** The platform asked for by a `#connect=` link or a "Connect"/"Update" button elsewhere. */
  highlighted: boolean;
  /** A connected card shows its two actions only after "Update". */
  expanded: boolean;
  /** Another read or save is running: the buttons wait. */
  busy: boolean;
  /** Something is open inside the card (the form or the reading state): hide the action buttons. */
  open: boolean;
  note: CardNote | null;
  onUpdate: () => void;
  /** Read a screenshot instead. Absent in a demo workspace (nothing real to read): the button is not drawn. */
  onUpload?: () => void;
  /** Sign in inside Pulse and read the numbers (Android app); on web and iOS it points to the Android app. */
  onConnect?: () => void;
  /** Demo workspace: the sign-in and the numbers are synthetic, so the badge says "Demo" instead of "Real". */
  demo?: boolean;
  /**
   * Pulse Desktop: the only action is "Connect with <Platform>" (its own login window). The screenshot upload shows only
   * once `uploadOffered` (a connect failed); a connected card gets a "Show <Platform>" link (`onShow`). Never set in a
   * demo workspace: the demo's sign-in is synthetic and opens no window.
   */
  desktop?: boolean;
  uploadOffered?: boolean;
  onShow?: () => void;
  /** Instagram, connected: copy the tracked link and open Instagram's edit-profile page. */
  onBioLink?: () => void;
  children?: ReactNode;
}

export function PlatformCard({
  platform,
  conn,
  updated,
  highlighted,
  expanded,
  busy,
  open,
  note,
  onUpdate,
  onUpload,
  onConnect,
  demo,
  desktop = false,
  uploadOffered = false,
  onShow,
  onBioLink,
  children,
}: PlatformCardProps) {
  const meta = platformMeta[platform];
  const connected = conn?.status === 'connected';
  const showActions = !open && (!connected || expanded);
  const summary = connected
    ? `${meta.label}, connected${conn.handle ? ` as ${conn.handle}` : ''}, ${followersLabel(conn.followers, fmtCompact)}${updated ? `, ${updated}` : ''}`
    : `${meta.label}, not connected`;

  return (
    <Card padded={false} style={highlighted ? { borderColor: withAlpha(colors.accent, 0.8) } : undefined}>
      <View style={styles.body} testID={`connect-card-${platform}`}>
        <View style={styles.head}>
          {/* One spoken summary per card on native (the Update button stays reachable); on web `accessible` only adds a tab stop. */}
          <View style={styles.headInfo} accessible={RNPlatform.OS !== 'web'} accessibilityLabel={summary}>
            <View style={styles.avatar}>
              <PlatformBadge platform={platform} size={40} style={connected ? undefined : styles.dimmed} />
              <View style={[styles.dot, connected ? styles.dotOn : styles.dotOff]} />
            </View>
            <View style={styles.info}>
              <View style={styles.titleLine}>
                <Text style={[styles.name, !connected && styles.nameOff]} numberOfLines={1}>
                  {meta.label}
                </Text>
                {connected ? (
                  demo ? <Badge label="Demo" tone="warn" icon="flask-outline" /> : <Badge label="Real" tone="success" icon="shield-checkmark" />
                ) : null}
              </View>
              {connected ? (
                <>
                  <Text style={styles.handle} numberOfLines={1}>
                    {conn.handle ? `${conn.handle} · ` : ''}
                    {followersLabel(conn.followers, fmtCompact)}
                  </Text>
                  {updated ? <Text style={t.small}>{updated}</Text> : null}
                </>
              ) : (
                <Text style={styles.handleOff}>Not connected</Text>
              )}
            </View>
          </View>
          {connected && !open ? (
            <Button
              small
              variant="secondary"
              title="Update"
              accessibilityLabel={`Update ${meta.label}`}
              disabled={busy}
              onPress={onUpdate}
              style={styles.update}
            />
          ) : null}
        </View>

        {desktop ? (
          <>
            {showActions ? (
              <>
                <Text style={t.small}>{`Sign in to ${meta.label} in its own window. Pulse reads your numbers for you.`}</Text>
                <View style={styles.actions}>
                  <Button
                    small
                    title={`Connect with ${meta.label}`}
                    icon="log-in-outline"
                    accessibilityLabel={`Connect with ${meta.label}`}
                    disabled={busy}
                    onPress={onConnect}
                  />
                </View>
              </>
            ) : null}
            {connected && !open && onShow ? (
              <Button
                small
                variant="ghost"
                title={`Show ${meta.label}`}
                icon="open-outline"
                accessibilityLabel={`Show ${meta.label}`}
                onPress={onShow}
                style={styles.link}
              />
            ) : null}
          </>
        ) : showActions ? (
          <>
            <Text style={t.small}>
              {demo
                ? `Sign in with the demo account and Pulse shows synthetic ${meta.label} numbers. Nothing is sent to ${meta.label}.`
                : onConnect
                  ? `Connect and Pulse reads your numbers for you. Only if that fails, upload a screenshot: ${PLATFORM_HELP[platform]}.`
                  : `Screenshot: ${PLATFORM_HELP[platform]}.`}
            </Text>
            <View style={styles.actions}>
              {onConnect ? (
                <Button
                  small
                  title={`Connect with ${meta.label}`}
                  icon="log-in-outline"
                  accessibilityLabel={`Connect with ${meta.label}`}
                  disabled={busy}
                  onPress={onConnect}
                />
              ) : null}
              {onUpload ? (
                <Button
                  small
                  variant={onConnect ? 'ghost' : 'primary'}
                  title={onConnect ? 'Or upload a screenshot' : 'Upload a screenshot'}
                  icon="image-outline"
                  accessibilityLabel={`Upload ${meta.label} screenshot`}
                  disabled={busy}
                  onPress={onUpload}
                  // Connecting comes first: the upload is the fallback, so it is drawn greyed out (still pressable).
                  style={onConnect ? styles.fallback : undefined}
                />
              ) : null}
            </View>
          </>
        ) : null}

        {connected && !open && onBioLink ? (
          <Button
            small
            variant="secondary"
            title="Put link in bio"
            icon="link-outline"
            accessibilityLabel="Put your Pulse link in your Instagram bio"
            disabled={busy}
            onPress={onBioLink}
            style={styles.link}
          />
        ) : null}

        {note ? (
          <View style={styles.note} accessibilityRole={note.tone === 'error' ? 'alert' : undefined}>
            <Ionicons
              name={note.tone === 'success' ? 'checkmark-circle' : note.tone === 'error' ? 'alert-circle' : 'information-circle-outline'}
              size={16}
              color={NOTE_COLOR[note.tone]}
            />
            <Text style={[t.small, styles.noteText]}>{note.text}</Text>
          </View>
        ) : null}

        {desktop && uploadOffered && !open ? (
          <>
            <Text style={t.small}>{`Screenshot: ${PLATFORM_HELP[platform]}.`}</Text>
            <Button
              small
              variant="ghost"
              title="Upload a screenshot instead"
              icon="image-outline"
              accessibilityLabel={`Upload ${meta.label} screenshot`}
              disabled={busy}
              onPress={onUpload}
              style={styles.link}
            />
          </>
        ) : null}

        {children}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 48 },
  headInfo: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: { width: 40, height: 40 },
  dimmed: { opacity: 0.5 },
  link: { alignSelf: 'flex-start' },
  fallback: { opacity: 0.5 },
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
  handle: { fontSize: 13.5, lineHeight: 18, color: colors.textDim },
  handleOff: { fontSize: 13.5, lineHeight: 18, color: colors.textMute },
  update: { minWidth: 88 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  noteText: { flex: 1, minWidth: 0 },
});
