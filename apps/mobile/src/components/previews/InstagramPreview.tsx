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

const PINK = '#ff4f8b';
const ORANGE = '#ff9a3c';

/** Instagram post: gradient-ring avatar, 1:1 gradient media with the image brief, actions, likes, caption. */
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
  const brief = mediaPrompt ?? '';
  const showBrief = editable || brief.trim().length > 0;

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

      <LinearGradient
        colors={[accentColor, PINK, ORANGE]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.media, small && styles.mediaCompact]}
      >
        <View style={[styles.circle, styles.circleA]} />
        <View style={[styles.circle, styles.circleB]} />
        <View style={[styles.circle, styles.circleC]} />
        {small ? null : (
          <View style={styles.mediaIcon}>
            <Ionicons name="sparkles" size={46} color="rgba(255, 255, 255, 0.72)" />
          </View>
        )}
        {showBrief ? (
          <View style={styles.brief}>
            <View style={styles.briefHead}>
              <Ionicons name="image-outline" size={13} color={colors.white} />
              <Text style={styles.briefLabel}>Image brief</Text>
            </View>
            <PreviewText
              value={brief}
              editable={editable}
              onChangeText={onChangeMediaPrompt}
              placeholder="Describe the image you want"
              style={styles.briefText}
              mutedColor="rgba(255, 255, 255, 0.6)"
              accent={colors.white}
              label="Image brief"
              maxLines={small ? 2 : 4}
            />
          </View>
        ) : null}
      </LinearGradient>

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

  media: { width: '100%', aspectRatio: 1, maxHeight: 520, overflow: 'hidden', alignItems: 'center', justifyContent: 'flex-end' },
  mediaCompact: { aspectRatio: 16 / 9, maxHeight: 220 },
  circle: { position: 'absolute', aspectRatio: 1, borderRadius: 999 },
  circleA: { width: '64%', top: '-16%', right: '-18%', backgroundColor: 'rgba(255, 255, 255, 0.15)' },
  circleB: { width: '50%', bottom: '-20%', left: '-14%', backgroundColor: 'rgba(255, 255, 255, 0.11)' },
  circleC: { width: '20%', top: '20%', left: '10%', backgroundColor: 'rgba(255, 255, 255, 0.13)' },
  mediaIcon: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  brief: {
    alignSelf: 'stretch',
    margin: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    backgroundColor: 'rgba(12, 10, 26, 0.56)',
  },
  briefHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  briefLabel: { color: colors.white, fontSize: 10.5, lineHeight: 14, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  briefText: { color: 'rgba(255, 255, 255, 0.95)', fontSize: 13, lineHeight: 18 },

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
