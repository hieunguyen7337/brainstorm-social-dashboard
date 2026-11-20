import Ionicons from '@expo/vector-icons/Ionicons';
import { memo, useEffect, useRef } from 'react';
import { Animated, Platform, StyleSheet, Text, View } from 'react-native';

import { PostPreview } from '@/src/components/previews';
import { fmtDateTime, timeAgo } from '@/src/format';
import { publishedCardTitle } from '@/src/realCopy';
import { useIsRealWorkspace } from '@/src/session';
import { colors, platformMeta, radius, withAlpha } from '@/src/theme';
import type { Post } from '@/src/types';

import { capitalise, type Draft } from './logic';

export interface PostPageProps {
  post: Post;
  /** The values to show: the user's unsaved edits on top of the saved post. */
  content: string;
  hashtags: string[];
  mediaPrompt: string;
  brandName: string;
  handle: string;
  followers?: number;
  /** Theme colour for the card's placeholders. */
  accentColor?: string;
  editable: boolean;
  /** Stable callback: writes into the local draft map keyed by post id. */
  onEdit: (id: string, patch: Partial<Draft>) => void;
  /** Stable callback: open the tracked link (a real visit that lands in the funnel). */
  onOpenLink: (post: Post) => void;
}

/**
 * "Published to LinkedIn" (in a real workspace "Marked as published on LinkedIn": Pulse never posts for the person) /
 * "Scheduled for ..." / "Failed" pill above the card; pops in when it appears.
 */
function StatusPill({ post }: { post: Post }) {
  const real = useIsRealWorkspace();
  const pop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(pop, { toValue: 1, friction: 6, tension: 120, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [pop]);

  const label = platformMeta[post.platform].label;
  let tint: string = colors.success;
  let icon: 'checkmark-circle' | 'time' | 'alert-circle' = 'checkmark-circle';
  let text = publishedCardTitle(label, real);
  if (post.status === 'scheduled') {
    tint = colors.info;
    icon = 'time';
    text = post.scheduled_at ? `Scheduled for ${fmtDateTime(post.scheduled_at)}` : 'Scheduled';
  } else if (post.status === 'failed') {
    tint = colors.danger;
    icon = 'alert-circle';
    text = `Couldn't publish to ${label}`;
  }

  return (
    <Animated.View
      accessibilityRole="text"
      style={[
        styles.pill,
        { backgroundColor: withAlpha(tint, 0.14), borderColor: withAlpha(tint, 0.45) },
        { opacity: pop, transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] },
      ]}
    >
      <Ionicons name={icon} size={16} color={tint} />
      <Text style={[styles.pillText, { color: tint }]} numberOfLines={1}>
        {text}
      </Text>
    </Animated.View>
  );
}

/** One card of the pager: the platform-native preview, editable while the post is still a draft. */
export const PostPage = memo(function PostPage({
  post,
  content,
  hashtags,
  mediaPrompt,
  brandName,
  handle,
  followers,
  accentColor,
  editable,
  onEdit,
  onOpenLink,
}: PostPageProps) {
  const published = post.status === 'published';
  const timeLabel =
    post.status === 'scheduled' && post.scheduled_at
      ? fmtDateTime(post.scheduled_at)
      : published && post.published_at
        ? capitalise(timeAgo(post.published_at)) || 'Just now'
        : 'Just now';

  return (
    <View style={styles.page}>
      {post.status !== 'draft' ? <StatusPill key={post.status} post={post} /> : null}
      <PostPreview
        platform={post.platform}
        content={content}
        hashtags={hashtags}
        mediaPrompt={mediaPrompt}
        brandName={brandName}
        handle={handle}
        followers={followers}
        link={post.link_url}
        accentColor={accentColor}
        timeLabel={timeLabel}
        editable={editable}
        onChangeContent={(text) => onEdit(post.id, { content: text })}
        onChangeHashtags={(tags) => onEdit(post.id, { hashtags: tags })}
        onChangeMediaPrompt={(text) => onEdit(post.id, { mediaPrompt: text })}
        // Only a published post's link is worth tapping: that click lands in the funnel.
        onPressLink={published ? () => onOpenLink(post) : undefined}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  page: { width: '100%', gap: 10 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    maxWidth: '100%',
  },
  pillText: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
});
