import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';

import { hashtagsText } from '@/src/format';
import { colors } from '@/src/theme';

import { HashtagsField, PreviewText } from './fields';
import {
  Avatar,
  CharCounter,
  HashtagSpans,
  IconCount,
  LinkCard,
  PreviewShell,
  cleanTags,
  identityOf,
  statsSpeech,
  tagsNotIn,
  withoutTrackedLink,
  type LinkPalette,
} from './parts';
import type { PreviewProps } from './types';

/** X dark ("Lights out") palette. */
const X = {
  bg: '#000000',
  border: '#2f3336',
  text: '#e7e9ea',
  mute: '#71767b',
  blue: '#1d9bf0',
  field: '#16181c',
} as const;

const LIMIT = 280;
/** X counts every link as 23 characters, whatever its length. */
const LINK_LENGTH = 23;

const LINK_PALETTE: LinkPalette = { bg: X.bg, border: X.border, text: X.text, mute: X.mute, cta: X.blue };

/** Tweet card: avatar, name + @handle, text with inline blue hashtags, link card, reply / repost / like / views / share. */
export function XPreview({
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
  const used = text.length + (inline.length ? 1 + hashtagsText(inline).length : 0) + (link ? 1 + LINK_LENGTH : 0);

  return (
    <PreviewShell background={X.bg} borderColor={X.border}>
      <View style={styles.row}>
        <Avatar initial={id.initial} size={40} accent={accentColor} />
        <View style={styles.main}>
          <View style={styles.head}>
            <Text style={styles.name} numberOfLines={1}>
              {id.name}
            </Text>
            <Text style={styles.handle} numberOfLines={1}>
              {id.at}
            </Text>
            <Text style={styles.time} numberOfLines={1}>{`· ${timeLabel}`}</Text>
            <Ionicons name="ellipsis-horizontal" size={16} color={X.mute} style={styles.more} />
          </View>

          <PreviewText
            value={text}
            editable={editable}
            onChangeText={onChangeContent}
            placeholder="What is happening?"
            style={styles.body}
            mutedColor={X.mute}
            accent={accentColor}
            label="Post text"
            maxLines={small ? 6 : undefined}
            suffix={<HashtagSpans tags={inline} color={X.blue} />}
          />

          {editable ? (
            <HashtagsField
              tags={tags}
              onChangeTags={onChangeHashtags}
              color={X.blue}
              mutedColor={X.mute}
              accent={accentColor}
              fill={X.field}
              borderColor={X.border}
              style={styles.tagsField}
              trailing={<CharCounter used={used} limit={LIMIT} color={X.mute} over={colors.danger} />}
            />
          ) : null}

          {link ? (
            <LinkCard
              variant="row"
              link={link}
              title={id.name}
              cta="Open link"
              accent={accentColor}
              palette={LINK_PALETTE}
              stats={stats}
              onPress={onPressLink}
              style={styles.link}
            />
          ) : null}

          <View
            style={styles.actions}
            accessible={Boolean(stats)}
            aria-hidden={stats ? undefined : true}
            accessibilityLabel={stats ? statsSpeech(stats) : undefined}
          >
            <IconCount icon="chatbubble-outline" color={X.mute} />
            <IconCount icon="repeat" color={X.mute} />
            <IconCount icon="heart-outline" color={X.mute} count={stats?.engagements} />
            <IconCount icon="stats-chart-outline" color={X.mute} count={stats?.views} />
            <IconCount icon="share-outline" color={X.mute} />
          </View>
        </View>
      </View>
    </PreviewShell>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10 },
  main: { flex: 1, minWidth: 0 },
  // The handle gives way first, then the name; the time label always stays readable.
  head: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
  name: { flexShrink: 0, maxWidth: '55%', color: X.text, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  handle: { flexShrink: 1, minWidth: 0, color: X.mute, fontSize: 15, lineHeight: 20 },
  time: { flexShrink: 0, color: X.mute, fontSize: 15, lineHeight: 20 },
  more: { marginLeft: 'auto', paddingLeft: 4 },
  body: { color: X.text, fontSize: 15, lineHeight: 21 },
  tagsField: { marginTop: 12 },
  link: { marginTop: 12 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingRight: 4 },
});
