/**
 * One platform in "Connect your real accounts": name, where to take the screenshot, "Upload a screenshot" and "Type
 * numbers"; once connected: handle, followers, a "Real" badge, "Updated <time>" and "Update". The numbers form (or the
 * "Claude is reading" state) opens inside the card as `children`.
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
  onUpload: () => void;
  onType: () => void;
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
  onType,
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
                {connected ? <Badge label="Real" tone="success" icon="shield-checkmark" /> : null}
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

        {showActions ? (
          <>
            <Text style={t.small}>{`Screenshot: ${PLATFORM_HELP[platform]}.`}</Text>
            <View style={styles.actions}>
              <Button
                small
                title="Upload a screenshot"
                icon="image-outline"
                accessibilityLabel={`Upload ${meta.label} screenshot`}
                disabled={busy}
                onPress={onUpload}
              />
              <Button
                small
                variant="secondary"
                title="Type numbers"
                icon="create-outline"
                accessibilityLabel={`Type ${meta.label} numbers`}
                disabled={busy}
                onPress={onType}
              />
            </View>
          </>
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
