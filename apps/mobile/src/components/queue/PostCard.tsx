import Ionicons from '@expo/vector-icons/Ionicons';
import { memo, useCallback, useMemo, useState, type ComponentProps } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import type { Post, PostStatus } from '@/src/api';
import { fmtDateTime, hashtagsText, inHours, timeAgo, tomorrowMorning } from '@/src/format';
import { ShareButtons } from '@/src/components/share/ShareButtons';
import type { ShareWiring } from '@/src/components/share/useShare';
import { colors, platformMeta, space, type as t } from '@/src/theme';
import {
  Badge,
  Button,
  Card,
  Chip,
  ChipRow,
  IconButton,
  PlatformBadge,
  copyText,
  useToast,
  type BadgeTone,
} from '@/src/ui';
import { LinkifiedText } from './LinkifiedText';
import { LinkRow } from './LinkRow';
import { LiveStats } from './LiveStats';
import { PostEditor } from './PostEditor';
import { PreviewBlock } from './PreviewBlock';
import { collapseText, type Account, type BusyKind } from './queueModel';
import { TextAction } from './TextAction';

type IconName = ComponentProps<typeof Ionicons>['name'];
type Mode = 'view' | 'edit' | 'schedule';

const STATUS: Record<PostStatus, { label: string; tone: BadgeTone; icon: IconName }> = {
  draft: { label: 'Draft', tone: 'neutral', icon: 'create-outline' },
  scheduled: { label: 'Scheduled', tone: 'info', icon: 'time-outline' },
  published: { label: 'Published', tone: 'success', icon: 'checkmark-circle' },
  failed: { label: 'Failed', tone: 'danger', icon: 'alert-circle' },
};

const SOURCE: Record<Post['source'], string> = { ai: 'AI', autopilot: 'Autopilot', manual: 'Manual', seed: 'Seed' };

interface TimeLine {
  icon: IconName;
  text: string;
  color: string;
}

/** "Scheduled for {date}" / "Published {ago}" / "Created {ago}" (relative parts follow `now`). */
function timeLine(post: Post, now: number): TimeLine {
  const created = timeAgo(post.created_at, now);
  switch (post.status) {
    case 'scheduled': {
      if (!post.scheduled_at) return { icon: 'calendar-outline', text: 'Scheduled', color: colors.info };
      const rel = timeAgo(post.scheduled_at, now);
      const countdown = rel.startsWith('in ') ? ` · ${rel}` : '';
      return {
        icon: 'calendar-outline',
        text: `Scheduled for ${fmtDateTime(post.scheduled_at)}${countdown}`,
        color: colors.info,
      };
    }
    case 'published': {
      const ago = timeAgo(post.published_at ?? post.created_at, now);
      return { icon: 'checkmark-done-outline', text: ago ? `Published ${ago}` : 'Published', color: colors.textDim };
    }
    case 'failed':
      return {
        icon: 'alert-circle-outline',
        text: `Couldn't publish${created ? ` · created ${created}` : ''}`,
        color: colors.danger,
      };
    default:
      return { icon: 'time-outline', text: created ? `Created ${created}` : 'Draft', color: colors.textDim };
  }
}

export interface PostCardProps {
  post: Post;
  /** Changes every few seconds so "3m ago" labels stay fresh without a data change. */
  now: number;
  /** This post has a request in flight. */
  busy?: BusyKind;
  /** A bulk publish is running: every card is read-only until it ends. */
  locked: boolean;
  brandName: string;
  account?: Account;
  onPublish: (post: Post) => void;
  onDelete: (post: Post) => void;
  onUnschedule: (post: Post) => void;
  onSchedule: (post: Post, iso: string) => void;
  /** Resolves true when the edit was saved (the card then leaves edit mode). */
  onSave: (post: Post, patch: { content: string; hashtags: string[] }) => Promise<boolean>;
  onOpenLink: (post: Post) => void;
  /** "Post it for real": how the share buttons mark this post published through the screen's own publish flow. */
  share?: ShareWiring;
  /**
   * A narrow kanban column (wide layout): the status badge is left to the column header (failed posts keep
   * theirs), the link row wraps and the live counters go 2 x 2. Phones never set it.
   */
  compact?: boolean;
}

/**
 * One post in the queue. Expansion, edit and schedule state live here (cards are keyed by post id), so they
 * survive the 5 s polls; the editor copies the text once, so a poll never overwrites what is being typed.
 */
function PostCardImpl({
  post,
  now,
  busy,
  locked,
  brandName,
  account,
  onPublish,
  onDelete,
  onUnschedule,
  onSchedule,
  onSave,
  onOpenLink,
  share,
  compact = false,
}: PostCardProps) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [mode, setMode] = useState<Mode>('view');

  const meta = platformMeta[post.platform];
  const status = STATUS[post.status] ?? STATUS.draft;
  const published = post.status === 'published';
  const scheduled = post.status === 'scheduled';
  const disabled = !!busy || locked;
  const content = post.content ?? '';
  const tags = post.hashtags ?? [];
  const { text: collapsed, truncated } = useMemo(() => collapseText(content), [content]);
  const when = timeLine(post, now);

  const copyLink = useCallback(async () => {
    if (!post.link_url) return;
    const ok = await copyText(post.link_url);
    toast.show(ok ? 'Tracked link copied' : "Couldn't copy the link", ok ? 'success' : 'error');
  }, [post.link_url, toast]);

  const openLink = useCallback(() => onOpenLink(post), [onOpenLink, post]);
  // The tracked link goes through onOpenLink (counts the click like a visitor); any other URL opens as is.
  const openText = useCallback(
    (url: string) => {
      if (post.link_url && url === post.link_url) onOpenLink(post);
      else void Linking.openURL(url).catch(() => undefined);
    },
    [onOpenLink, post],
  );

  const handleSave = useCallback(
    async (nextContent: string, hashtags: string[]) => {
      if (await onSave(post, { content: nextContent, hashtags })) setMode('view');
    },
    [onSave, post],
  );

  const schedule = (iso: string) => {
    setMode('view');
    onSchedule(post, iso);
  };

  const previewTime = published
    ? timeAgo(post.published_at ?? post.created_at, now)
    : scheduled && post.scheduled_at
      ? fmtDateTime(post.scheduled_at)
      : timeAgo(post.created_at, now);

  return (
    <Card style={styles.card}>
      <View style={styles.header}>
        <PlatformBadge platform={post.platform} size={36} />
        <View style={styles.headerMain}>
          <Text style={[t.h3, styles.platform]} numberOfLines={1}>
            {meta.label}
          </Text>
          <View style={styles.sourceTag}>
            <Text style={styles.sourceText} numberOfLines={1}>
              {SOURCE[post.source] ?? post.source}
            </Text>
          </View>
        </View>
        {!compact || post.status === 'failed' ? (
          <Badge label={status.label} tone={status.tone} icon={status.icon} style={styles.badge} />
        ) : null}
      </View>

      <View style={styles.timeRow}>
        <Ionicons name={when.icon} size={14} color={when.color} />
        <Text style={[styles.time, { color: when.color }]} numberOfLines={2}>
          {when.text}
        </Text>
      </View>

      {mode === 'edit' ? (
        <PostEditor post={post} saving={busy === 'save'} onSave={handleSave} onCancel={() => setMode('view')} />
      ) : (
        <View style={styles.body}>
          <LinkifiedText style={styles.content} selectable onPressUrl={openText}>
            {expanded || !truncated ? content : collapsed}
          </LinkifiedText>
          {tags.length > 0 ? <Text style={styles.tags}>{hashtagsText(tags)}</Text> : null}
          <View style={styles.bodyActions}>
            {truncated ? (
              <TextAction
                label={expanded ? 'Show less' : 'Show more'}
                icon={expanded ? 'chevron-up' : 'chevron-down'}
                tone="accent"
                onPress={() => setExpanded((v) => !v)}
              />
            ) : null}
            <TextAction
              label={previewing ? 'Hide preview' : 'Preview'}
              icon="phone-portrait-outline"
              onPress={() => setPreviewing((v) => !v)}
            />
          </View>
          {previewing ? (
            <PreviewBlock post={post} brandName={brandName} account={account} timeLabel={previewTime} />
          ) : null}
        </View>
      )}

      {published ? (
        <LiveStats
          counters={{
            views: post.views,
            engagements: post.engagements,
            clicks: post.clicks,
            conversions: post.conversions,
          }}
          compact={compact}
        />
      ) : null}

      {mode !== 'edit' && post.link_url ? (
        <LinkRow url={post.link_url} onCopy={copyLink} onOpen={openLink} compact={compact} />
      ) : null}

      {mode !== 'edit' ? <ShareButtons post={post} compact={compact} small disabled={disabled} {...share} /> : null}

      {mode !== 'edit' ? (
        published ? (
          <View style={styles.footer}>
            <TextAction
              label="Delete"
              icon="trash-outline"
              tone="danger"
              disabled={disabled}
              onPress={() => onDelete(post)}
              accessibilityLabel="Delete post"
            />
          </View>
        ) : (
          <View style={styles.actions}>
            <Button
              title="Publish now"
              small
              loading={busy === 'publish'}
              disabled={disabled}
              onPress={() => onPublish(post)}
            />
            {scheduled ? (
              <Button
                title="Move to drafts"
                variant="secondary"
                small
                loading={busy === 'unschedule'}
                disabled={disabled}
                onPress={() => onUnschedule(post)}
              />
            ) : (
              <>
                <Button
                  title="Schedule"
                  variant="secondary"
                  small
                  disabled={disabled}
                  onPress={() => setMode((m) => (m === 'schedule' ? 'view' : 'schedule'))}
                />
                <Button title="Edit" variant="secondary" small disabled={disabled} onPress={() => setMode('edit')} />
              </>
            )}
            <View style={styles.actionsEnd}>
              <IconButton
                icon="trash-outline"
                label="Delete post"
                color={colors.danger}
                disabled={disabled}
                onPress={() => onDelete(post)}
              />
            </View>
          </View>
        )
      ) : null}

      {mode === 'schedule' ? (
        <View style={styles.chooser}>
          <Text style={t.label}>Schedule for</Text>
          <ChipRow>
            <Chip label="In 1 hour" disabled={disabled} onPress={() => schedule(inHours(1))} />
            <Chip label="In 3 hours" disabled={disabled} onPress={() => schedule(inHours(3))} />
            <Chip label="Tomorrow 9:00" disabled={disabled} onPress={() => schedule(tomorrowMorning())} />
          </ChipRow>
        </View>
      ) : null}
    </Card>
  );
}

/** Memoised: with structural sharing in the screen, only cards whose post (or `now`) changed re-render. */
export const PostCard = memo(PostCardImpl);

const styles = StyleSheet.create({
  card: { gap: space.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  headerMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  platform: { flexShrink: 1 },
  sourceTag: {
    flexShrink: 0,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sourceText: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.3, color: colors.textMute },
  badge: { alignSelf: 'center', flexShrink: 0 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -4 },
  time: { flexShrink: 1, fontSize: 12.5, lineHeight: 17, fontWeight: '600' },
  body: { gap: space.sm },
  content: { ...t.body },
  tags: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: colors.accent },
  bodyActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: space.lg, marginTop: -4 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: -4 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  actionsEnd: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: space.sm },
  chooser: {
    gap: space.sm,
    padding: space.md,
    borderRadius: 12,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
});
