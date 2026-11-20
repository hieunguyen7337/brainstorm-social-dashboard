import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { fmtCompact, fmtInt } from '@/src/format';
import { colors } from '@/src/theme';

import { HashtagsField, PreviewText } from './fields';
import {
  Avatar,
  HashtagSpans,
  LinkPill,
  PreviewShell,
  cleanTags,
  identityOf,
  statsSpeech,
  tagsNotIn,
  withoutTrackedLink,
} from './parts';
import type { PreviewProps } from './types';
import { InstagramVisual } from './visual-frames';

/** Instagram dark palette. */
const IG = {
  bg: '#000000',
  border: '#262626',
  text: '#f5f5f5',
  mute: '#a8a8a8',
  blue: '#6cb4ff',
  field: '#121212',
  pill: '#1a1a1a',
} as const;

/**
 * Instagram post: gradient-ring avatar, a true 1:1 square whose content is the visual plan (media_prompt, editable in
 * place), actions, likes, caption with handle and hashtags, "Link in bio" chip.
 */
export function InstagramPreview({
  content,
  hashtags,
  mediaPrompt,
  brandName,
  handle,
  link,
  accentColor = colors.accent,
  timeLabel = 'Just now',
  editable = false,
  compact = false,
  stats,
  onChangeContent,
  onChangeHashtags,
  onChangeMediaPrompt,
  onPressLink,
}: PreviewProps) {
  const id = identityOf(brandName, handle);
  const small = compact && !editable;
  const text = withoutTrackedLink(content, link);
  const tags = cleanTags(hashtags);
  const inline = tagsNotIn(tags, text);

  return (
    <PreviewShell background={IG.bg} borderColor={IG.border}>
      <View style={styles.header}>
        <LinearGradient
          colors={['#feda75', '#fa7e1e', '#d62976', '#962fbf', '#4f5bd5']}
          start={{ x: 0, y: 1 }}
          end={{ x: 1, y: 0 }}
          style={styles.ring}
        >
          <View style={styles.ringGap}>
            <Avatar initial={id.initial} size={30} accent={accentColor} />
          </View>
        </LinearGradient>
        <Text style={styles.handle} numberOfLines={1}>
          {id.plain}
        </Text>
        <Ionicons name="ellipsis-horizontal" size={20} color={IG.text} />
      </View>

      <InstagramVisual
        plan={mediaPrompt ?? ''}
        accentColor={accentColor}
        editable={editable}
        compact={small}
        onChangePlan={onChangeMediaPrompt}
      />

      <View style={styles.actions} aria-hidden>
        <View style={styles.actionsLeft}>
          <Ionicons name="heart-outline" size={27} color={IG.text} />
          <Ionicons name="chatbubble-outline" size={25} color={IG.text} />
          <Ionicons name="paper-plane-outline" size={25} color={IG.text} />
        </View>
        <Ionicons name="bookmark-outline" size={25} color={IG.text} />
      </View>

      <View style={styles.meta}>
        <Text
          style={styles.likes}
          accessibilityLabel={stats ? statsSpeech(stats) : undefined}
          numberOfLines={1}
        >
          {stats ? `${fmtInt(stats.engagements)} likes` : 'Be the first to like this'}
          {stats ? <Text style={styles.views}>{`  ·  ${fmtCompact(stats.views)} views`}</Text> : null}
        </Text>

        <PreviewText
          value={text}
          editable={editable}
          onChangeText={onChangeContent}
          placeholder="Write a caption..."
          style={styles.caption}
          mutedColor={IG.mute}
          accent={accentColor}
          label="Caption"
          maxLines={small ? 3 : undefined}
          prefix={<Text style={styles.captionHandle}>{`${id.plain} `}</Text>}
          suffix={<HashtagSpans tags={inline} color={IG.blue} />}
        />

        {editable ? (
          <HashtagsField
            tags={tags}
            onChangeTags={onChangeHashtags}
            color={IG.blue}
            mutedColor={IG.mute}
            accent={accentColor}
            fill={IG.field}
            borderColor={IG.border}
            style={styles.tagsField}
          />
        ) : null}

        {link ? (
          <LinkPill
            link={link}
            label="Link in bio"
            color={IG.text}
            mute={IG.mute}
            bg={IG.pill}
            border={IG.border}
            stats={stats}
            onPress={onPressLink}
            style={styles.linkPill}
          />
        ) : null}

        {small ? null : (
          <Text style={styles.comments} aria-hidden>
            View all comments
          </Text>
        )}
        <Text style={styles.time} numberOfLines={1}>
          {timeLabel.toUpperCase()}
        </Text>
      </View>
    </PreviewShell>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  ring: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  ringGap: { width: 34, height: 34, borderRadius: 17, backgroundColor: IG.bg, alignItems: 'center', justifyContent: 'center' },
  handle: { flex: 1, minWidth: 0, color: IG.text, fontSize: 14, lineHeight: 18, fontWeight: '700' },

  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  actionsLeft: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  meta: { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  likes: { color: IG.text, fontSize: 14, lineHeight: 19, fontWeight: '700' },
  views: { color: IG.mute, fontWeight: '400' },
  caption: { color: IG.text, fontSize: 14, lineHeight: 19 },
  captionHandle: { color: IG.text, fontWeight: '700' },
  tagsField: { marginTop: 8 },
  linkPill: { marginTop: 4 },
  comments: { color: IG.mute, fontSize: 14, lineHeight: 19 },
  time: { color: IG.mute, fontSize: 10.5, lineHeight: 14, letterSpacing: 0.3 },
});
