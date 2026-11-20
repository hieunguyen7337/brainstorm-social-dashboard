import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fmtDateTime, inHours, tomorrowMorning } from '@/src/format';
import { colors, platformMeta, space, type as t, withAlpha } from '@/src/theme';
import { ShareButtons } from '@/src/components/share/ShareButtons';
import type { ShareWiring } from '@/src/components/share/useShare';
import type { Post } from '@/src/types';
import { Button, Card, Chip, ChipRow, IconButton } from '@/src/ui';

import type { Busy } from './logic';

export interface PostActionsProps {
  post: Post;
  /** Has unsaved local edits. */
  dirty: boolean;
  /** What this card is doing right now (disables its buttons, spins the active one). */
  busy?: Busy;
  /** Something else (Publish all) is running: hold every button. */
  locked: boolean;
  /** The last failure for this card, shown until the next action. */
  error?: string;
  /** Enough room for a single row of buttons. */
  wide: boolean;
  /** Very little room (a card in the wide board's 2-column grid): the buttons stack instead of sharing a row. */
  compact?: boolean;
  /** "Post it for real": the unsaved text on screen and how the share buttons mark this post published. */
  share?: ShareWiring;
  onPublish: () => void;
  onSchedule: (iso: string) => void;
  onSaveEdits: () => void;
  onCopyLink: () => void;
  onDiscard: () => void;
  onOpenLink: () => void;
  onViewQueue: (tab: 'published' | 'scheduled') => void;
}

/** A line of feedback with an icon. */
function Notice({ text, tone }: { text: string; tone: 'danger' | 'info' }) {
  const c = tone === 'danger' ? colors.danger : colors.info;
  return (
    <View style={[styles.notice, { backgroundColor: withAlpha(c, 0.12), borderColor: withAlpha(c, 0.35) }]}>
      <Ionicons name={tone === 'danger' ? 'alert-circle' : 'information-circle'} size={16} color={c} />
      <Text style={[styles.noticeText, { color: c }]}>{text}</Text>
    </View>
  );
}

/** Publish / Schedule / Copy link / Discard for a card that is still a draft (or failed to publish). */
function DraftActions({
  post,
  dirty,
  busy,
  locked,
  error,
  wide,
  compact = false,
  share,
  onPublish,
  onSchedule,
  onSaveEdits,
  onCopyLink,
  onDiscard,
}: PostActionsProps) {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const blocked = locked || busy !== undefined;
  const label = platformMeta[post.platform].label;

  const publish = (
    <Button
      title="Publish"
      icon="paper-plane"
      full={!wide && !compact}
      style={compact ? styles.grow : wide ? styles.growMore : undefined}
      loading={busy === 'publishing'}
      disabled={blocked && busy !== 'publishing'}
      onPress={onPublish}
    />
  );
  const schedule = (
    <Button
      title="Schedule"
      icon="time-outline"
      variant="secondary"
      style={styles.grow}
      disabled={blocked}
      loading={busy === 'scheduling'}
      onPress={() => setScheduleOpen((open) => !open)}
    />
  );
  const copy = post.link_url ? (
    <Button title="Copy link" icon="link-outline" variant="ghost" style={styles.grow} disabled={blocked} onPress={onCopyLink} />
  ) : null;
  const discard = (
    <IconButton
      icon="trash-outline"
      label={`Discard the ${label} draft`}
      color={colors.danger}
      disabled={blocked}
      onPress={onDiscard}
      style={styles.discard}
    />
  );

  return (
    <View style={styles.wrap}>
      {error ? (
        <Notice tone="danger" text={error} />
      ) : post.status === 'failed' ? (
        <Notice tone="danger" text={`Publishing to ${label} failed. Edit it if you like and try again.`} />
      ) : null}
      {dirty ? (
        <View style={styles.dirty}>
          <Text style={styles.dirtyText}>You have unsaved edits</Text>
          <Button
            title="Save edits"
            icon="save-outline"
            variant="secondary"
            small
            loading={busy === 'saving'}
            disabled={blocked && busy !== 'saving'}
            onPress={onSaveEdits}
          />
        </View>
      ) : null}
      {compact ? (
        <>
          <View style={styles.row}>
            {publish}
            {discard}
          </View>
          <View style={styles.row}>
            {schedule}
            {copy}
          </View>
        </>
      ) : wide ? (
        <View style={styles.row}>
          {publish}
          {schedule}
          {copy}
          {discard}
        </View>
      ) : (
        <>
          {publish}
          <View style={styles.row}>
            {schedule}
            {copy}
            {discard}
          </View>
        </>
      )}
      <ShareButtons post={post} compact={compact || !wide} disabled={blocked} {...share} />
      {scheduleOpen ? (
        <View style={styles.choices}>
          <Text style={t.label}>Schedule for</Text>
          <ChipRow>
            <Chip icon="time-outline" label="In 1 hour" disabled={blocked} onPress={() => onSchedule(inHours(1))} />
            <Chip icon="time-outline" label="In 3 hours" disabled={blocked} onPress={() => onSchedule(inHours(3))} />
            <Chip icon="sunny-outline" label="Tomorrow 9:00" disabled={blocked} onPress={() => onSchedule(tomorrowMorning())} />
          </ChipRow>
        </View>
      ) : null}
    </View>
  );
}

/** After publishing: the tracked link, "Open link" (lands a real click in the funnel) and a way to the queue. */
function PublishedCard({
  post,
  busy,
  locked,
  wide,
  compact = false,
  share,
  onOpenLink,
  onCopyLink,
  onViewQueue,
}: PostActionsProps) {
  const label = platformMeta[post.platform].label;
  return (
    <Card tone="raised" style={[styles.stateCard, { borderColor: withAlpha(colors.success, 0.4) }]}>
      <View style={styles.head}>
        <Ionicons name="checkmark-circle" size={22} color={colors.success} />
        <View style={styles.headText}>
          <Text style={t.h3}>{`Published to ${label}`}</Text>
          <Text style={t.small}>Sandbox mode: your numbers start moving on the dashboard.</Text>
        </View>
      </View>
      {post.link_url ? (
        <View style={styles.linkRow}>
          <Ionicons name="link-outline" size={16} color={colors.textDim} />
          <Text style={styles.link} numberOfLines={1} selectable>
            {post.link_url}
          </Text>
          <IconButton icon="copy-outline" label="Copy tracked link" size={18} onPress={onCopyLink} />
        </View>
      ) : null}
      <ShareButtons post={post} compact={compact || !wide} disabled={locked || busy !== undefined} {...share} />
      <View style={compact ? styles.stack : styles.row}>
        {post.link_url ? (
          <Button title="Open link" icon="open-outline" full={compact} style={compact ? undefined : styles.grow} onPress={onOpenLink} />
        ) : null}
        <Button
          title="View in Queue"
          icon="albums-outline"
          variant="secondary"
          full={compact}
          style={compact ? undefined : styles.grow}
          onPress={() => onViewQueue('published')}
        />
      </View>
      {post.link_url ? <Text style={t.small}>Open the link yourself and watch your click land in the funnel.</Text> : null}
    </Card>
  );
}

/** After scheduling: when it goes out, and a way to the queue. */
function ScheduledCard({ post, busy, locked, wide, compact = false, share, onCopyLink, onViewQueue }: PostActionsProps) {
  const label = platformMeta[post.platform].label;
  return (
    <Card tone="raised" style={[styles.stateCard, { borderColor: withAlpha(colors.info, 0.4) }]}>
      <View style={styles.head}>
        <Ionicons name="time" size={22} color={colors.info} />
        <View style={styles.headText}>
          <Text style={t.h3}>
            {post.scheduled_at ? `Scheduled for ${fmtDateTime(post.scheduled_at)}` : `Scheduled on ${label}`}
          </Text>
          <Text style={t.small}>{`Your ${label} post waits in the queue until then.`}</Text>
        </View>
      </View>
      <ShareButtons post={post} compact={compact || !wide} disabled={locked || busy !== undefined} {...share} />
      <View style={compact ? styles.stack : styles.row}>
        <Button
          title="View in Queue"
          icon="albums-outline"
          variant="secondary"
          full={compact}
          style={compact ? undefined : styles.grow}
          onPress={() => onViewQueue('scheduled')}
        />
        {post.link_url ? (
          <Button
            title="Copy link"
            icon="link-outline"
            variant="ghost"
            full={compact}
            style={compact ? undefined : styles.grow}
            onPress={onCopyLink}
          />
        ) : null}
      </View>
    </Card>
  );
}

/** The actions under the active card. Render with `key={post.id}` so per-card UI state resets when the card changes. */
export function PostActions(props: PostActionsProps) {
  if (props.post.status === 'published') return <PublishedCard {...props} />;
  if (props.post.status === 'scheduled') return <ScheduledCard {...props} />;
  return <DraftActions {...props} />;
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stack: { gap: space.sm },
  grow: { flex: 1 },
  growMore: { flex: 1.6 },
  discard: { width: 48, height: 48, borderRadius: 16 },
  dirty: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  dirtyText: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.textDim },
  choices: { gap: space.sm },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    borderRadius: 12,
    borderWidth: 1,
  },
  noticeText: { flex: 1, fontSize: 13.5, lineHeight: 19, fontWeight: '600' },
  stateCard: { gap: space.md },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.md,
    paddingRight: 4,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  link: { flex: 1, minWidth: 0, fontSize: 13, color: colors.text },
});
