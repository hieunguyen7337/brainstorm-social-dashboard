import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { fmtCompact, fmtInt } from '@/src/format';
import { colors } from '@/src/theme';

import { HashtagsField, PreviewText } from './fields';
import {
  Avatar,
  Divider,
  HashtagSpans,
  LinkCard,
  PreviewShell,
  ReactionDot,
  TimeGlobe,
  cleanTags,
  identityOf,
  statsSpeech,
  tagsNotIn,
  withoutTrackedLink,
  type IonName,
  type LinkPalette,
} from './parts';
import type { PreviewProps } from './types';

/** Facebook dark palette. */
const FB = {
  bg: '#242526',
  border: '#3e4042',
  text: '#e4e6eb',
  mute: '#b0b3b8',
  blue: '#2d88ff',
  field: '#3a3b3c',
  button: '#4e4f50',
} as const;

const LINK_PALETTE: LinkPalette = {
  bg: FB.field,
  border: FB.border,
  text: FB.text,
  mute: FB.mute,
  cta: FB.text,
  ctaBg: FB.button,
  ctaText: FB.text,
};

const ACTIONS: { icon: IonName; label: string }[] = [
  { icon: 'thumbs-up-outline', label: 'Like' },
  { icon: 'chatbubble-outline', label: 'Comment' },
  { icon: 'arrow-redo-outline', label: 'Share' },
];

/** Facebook page post: page name + time, text, big link preview with "Learn more", reaction summary, action bar. */
export function FacebookPreview({
  content,
  hashtags,
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
  onPressLink,
}: PreviewProps) {
  const id = identityOf(brandName, handle);
  const small = compact && !editable;
  const text = withoutTrackedLink(content, link);
  const tags = cleanTags(hashtags);
  const inline = tagsNotIn(tags, text);

  return (
    <PreviewShell background={FB.bg} borderColor={FB.border}>
      <View style={styles.header}>
        <Avatar initial={id.initial} size={40} accent={accentColor} />
        <View style={styles.headText}>
          <Text style={styles.name} numberOfLines={1}>
            {id.name}
          </Text>
          <TimeGlobe label={timeLabel} color={FB.mute} size={13} />
        </View>
        <Ionicons name="ellipsis-horizontal" size={20} color={FB.mute} />
      </View>

      <View style={styles.body}>
        <PreviewText
          value={text}
          editable={editable}
          onChangeText={onChangeContent}
          placeholder="What's on your mind?"
          style={styles.text}
          mutedColor={FB.mute}
          accent={accentColor}
          label="Post text"
          maxLines={small ? 4 : undefined}
          suffix={<HashtagSpans tags={inline} color={FB.blue} lead={'\n\n'} />}
        />
        {editable ? (
          <HashtagsField
            tags={tags}
            onChangeTags={onChangeHashtags}
            color={FB.blue}
            mutedColor={FB.mute}
            accent={accentColor}
            fill={FB.field}
            borderColor={FB.border}
            style={styles.tagsField}
          />
        ) : null}
      </View>

      {link ? (
        small ? (
          <View style={styles.linkPad}>
            <LinkCard
              variant="row"
              link={link}
              title={id.name}
              cta="Learn more"
              accent={accentColor}
              palette={LINK_PALETTE}
              stats={stats}
              onPress={onPressLink}
              style={styles.linkRow}
            />
          </View>
        ) : (
          <LinkCard
            variant="banner"
            flush
            button
            link={link}
            title={id.name}
            cta="Learn more"
            accent={accentColor}
            palette={LINK_PALETTE}
            stats={stats}
            onPress={onPressLink}
          />
        )
      ) : null}

      <View
        style={styles.summary}
        accessible={Boolean(stats)}
        aria-hidden={stats ? undefined : true}
        accessibilityLabel={stats ? statsSpeech(stats) : undefined}
      >
        <View style={styles.dots}>
          <ReactionDot icon="thumbs-up" bg="#1877f2" ring={FB.bg} />
          <View style={styles.dotOverlap}>
            <ReactionDot icon="heart" bg="#f33e58" ring={FB.bg} />
          </View>
        </View>
        <Text style={styles.summaryText} numberOfLines={1}>
          {stats ? fmtInt(stats.engagements) : 'Be the first to react'}
        </Text>
        {stats ? <Text style={styles.views}>{fmtCompact(stats.views)} views</Text> : null}
      </View>

      <Divider color={FB.border} style={styles.divider} />
      <View style={styles.bar} aria-hidden>
        {ACTIONS.map((a) => (
          <View key={a.label} style={styles.barItem}>
            <Ionicons name={a.icon} size={20} color={FB.mute} />
            <Text style={styles.barLabel}>{a.label}</Text>
          </View>
        ))}
      </View>
    </PreviewShell>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 10 },
  headText: { flex: 1, minWidth: 0, gap: 1 },
  name: { color: FB.text, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  body: { paddingHorizontal: 12, paddingBottom: 12 },
  text: { color: FB.text, fontSize: 15, lineHeight: 20 },
  tagsField: { marginTop: 14 },
  linkPad: { paddingHorizontal: 12, paddingBottom: 12 },
  linkRow: { borderRadius: 10 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  dots: { flexDirection: 'row', alignItems: 'center' },
  dotOverlap: { marginLeft: -7 },
  summaryText: { flex: 1, minWidth: 0, color: FB.mute, fontSize: 14, lineHeight: 19, fontVariant: ['tabular-nums'] },
  views: { color: FB.mute, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  divider: { marginHorizontal: 12 },
  bar: { flexDirection: 'row', paddingHorizontal: 4, paddingVertical: 4 },
  barItem: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  barLabel: { color: FB.mute, fontSize: 14, fontWeight: '600' },
});
