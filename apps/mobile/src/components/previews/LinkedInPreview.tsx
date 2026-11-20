import Ionicons from '@expo/vector-icons/Ionicons';
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

/** LinkedIn dark palette. */
const L = {
  bg: '#1b1f23',
  border: '#38434f',
  text: 'rgba(255, 255, 255, 0.9)',
  mute: 'rgba(255, 255, 255, 0.6)',
  blue: '#70b5f9',
  field: '#22272c',
  strip: '#252b31',
} as const;

const LINK_PALETTE: LinkPalette = { bg: L.strip, border: L.border, text: L.text, mute: L.mute, cta: L.blue };

const REACTIONS: { icon: IonName; label: string }[] = [
  { icon: 'thumbs-up-outline', label: 'Like' },
  { icon: 'chatbubble-ellipses-outline', label: 'Comment' },
  { icon: 'repeat', label: 'Repost' },
  { icon: 'paper-plane-outline', label: 'Send' },
];

/** LinkedIn post: square-ish avatar, followers + time, paragraphs, blue hashtags, article card, reaction bar. */
export function LinkedInPreview({
  content,
  hashtags,
  brandName,
  handle,
  followers,
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
  const followersLine =
    typeof followers === 'number' && Number.isFinite(followers)
      ? `${fmtInt(followers)} follower${Math.round(followers) === 1 ? '' : 's'}`
      : '';

  return (
    <PreviewShell background={L.bg} borderColor={L.border}>
      <View style={styles.header}>
        <Avatar initial={id.initial} size={48} accent={accentColor} shape="square" />
        <View style={styles.headText}>
          <Text style={styles.name} numberOfLines={1}>
            {id.name}
          </Text>
          {followersLine ? (
            <Text style={styles.sub} numberOfLines={1}>
              {followersLine}
            </Text>
          ) : null}
          <TimeGlobe label={timeLabel} color={L.mute} />
        </View>
        <Ionicons name="ellipsis-horizontal" size={20} color={L.mute} />
      </View>

      <View style={styles.body}>
        <PreviewText
          value={text}
          editable={editable}
          onChangeText={onChangeContent}
          placeholder="What do you want to talk about?"
          style={styles.text}
          mutedColor={L.mute}
          accent={accentColor}
          label="Post text"
          maxLines={small ? 5 : undefined}
          suffix={<HashtagSpans tags={inline} color={L.blue} lead={'\n\n'} weight="600" />}
        />
        {editable ? (
          <HashtagsField
            tags={tags}
            onChangeTags={onChangeHashtags}
            color={L.blue}
            mutedColor={L.mute}
            accent={accentColor}
            fill={L.field}
            borderColor={L.border}
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
              cta="Open link"
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
            link={link}
            title={id.name}
            cta="Open link"
            accent={accentColor}
            palette={LINK_PALETTE}
            stats={stats}
            onPress={onPressLink}
          />
        )
      ) : null}

      {stats ? (
        <View style={styles.counts} accessible accessibilityLabel={statsSpeech(stats)}>
          <View style={styles.reactions}>
            <ReactionDot icon="thumbs-up" bg="#378fe9" ring={L.bg} />
            <View style={styles.dotOverlap}>
              <ReactionDot icon="heart" bg="#df704d" ring={L.bg} />
            </View>
            <Text style={styles.countText}>{fmtInt(stats.engagements)}</Text>
          </View>
          <Text style={styles.countText}>{fmtCompact(stats.views)} impressions</Text>
        </View>
      ) : null}

      <Divider color={L.border} style={styles.divider} />
      <View style={styles.bar} aria-hidden>
        {REACTIONS.map((r) => (
          <View key={r.label} style={styles.barItem}>
            <Ionicons name={r.icon} size={20} color={L.mute} />
            <Text style={styles.barLabel} numberOfLines={1}>
              {r.label}
            </Text>
          </View>
        ))}
      </View>
    </PreviewShell>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 12, paddingTop: 12 },
  headText: { flex: 1, minWidth: 0, gap: 1 },
  name: { color: L.text, fontSize: 14, lineHeight: 19, fontWeight: '700' },
  sub: { color: L.mute, fontSize: 12, lineHeight: 16 },
  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  text: { color: L.text, fontSize: 14, lineHeight: 20 },
  tagsField: { marginTop: 14 },
  linkPad: { paddingHorizontal: 12, paddingBottom: 12 },
  linkRow: { borderRadius: 10 },
  counts: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  reactions: { flexDirection: 'row', alignItems: 'center' },
  dotOverlap: { marginLeft: -7, marginRight: 6 },
  countText: { color: L.mute, fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
  divider: { marginHorizontal: 12 },
  bar: { flexDirection: 'row', paddingHorizontal: 4, paddingVertical: 4 },
  barItem: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  barLabel: { color: L.mute, fontSize: 13, fontWeight: '600' },
});
