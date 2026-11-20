import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { fmtCompact } from '@/src/format';
import { colors, withAlpha } from '@/src/theme';

import { HashtagsField, PreviewText } from './fields';
import {
  HashtagSpans,
  LinkPill,
  PreviewShell,
  cleanTags,
  firstLine,
  identityOf,
  statsSpeech,
  tagsNotIn,
  withoutTrackedLink,
  type IonName,
} from './parts';
import type { PreviewProps } from './types';

/** TikTok dark palette. */
const TT = {
  border: '#2a2a2e',
  text: '#ffffff',
  mute: 'rgba(255, 255, 255, 0.72)',
  cyan: '#25f4ee',
  field: '#161618',
  pill: 'rgba(255, 255, 255, 0.12)',
  pillBorder: 'rgba(255, 255, 255, 0.2)',
} as const;

/** A "phone screen" is at most this wide and (read-only) this tall; the card centres it on wide parents. */
const SCREEN_MAX_WIDTH = 400;
const SCREEN_HEIGHT = 460;
const SCREEN_HEIGHT_COMPACT = 380;

function RailItem({ icon, label }: { icon: IonName; label: string }) {
  return (
    <View style={styles.railItem}>
      <Ionicons name={icon} size={28} color={TT.text} />
      <Text style={styles.railLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** TikTok: tall vertical-gradient screen, the content as the on-screen script, action rail, handle + caption + sound. */
export function TikTokPreview({
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
  const caption = firstLine(text);
  const inline = tagsNotIn(tags, caption);
  const brief = mediaPrompt ?? '';
  // The compact card drops the shot list; the full card shows it when there is one (or while editing).
  const showBrief = !small && (editable || brief.trim().length > 0);
  const height = small ? SCREEN_HEIGHT_COMPACT : SCREEN_HEIGHT;

  return (
    <PreviewShell background="#000000" borderColor={TT.border} style={styles.shell}>
      <LinearGradient
        colors={[withAlpha(accentColor, 0.62), '#15161f', '#000000']}
        locations={[0, 0.5, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        // Read-only: a fixed cap. Editing: at least the cap, growing with the script instead of clipping it.
        style={[styles.screen, editable ? { minHeight: height } : { height }]}
      >
        <View style={styles.top}>
          {showBrief ? (
            <View style={styles.chip}>
              <View style={styles.chipHead}>
                <Ionicons name="videocam-outline" size={14} color={TT.cyan} />
                <Text style={styles.chipLabel}>Shot list</Text>
              </View>
              <PreviewText
                value={brief}
                editable={editable}
                onChangeText={onChangeMediaPrompt}
                placeholder="Describe the shots you want"
                style={styles.chipText}
                mutedColor="rgba(255, 255, 255, 0.55)"
                accent={TT.cyan}
                label="Shot list"
                maxLines={3}
              />
            </View>
          ) : null}
        </View>

        <View style={editable ? styles.scriptEdit : styles.scriptView}>
          {/* Centred while it fits; once it overflows the auto margins collapse so the hook stays on screen. */}
          <View style={styles.scriptInner}>
            <PreviewText
              value={text}
              editable={editable}
              onChangeText={onChangeContent}
              placeholder="Hook, beats and call to action"
              style={styles.scriptText}
              mutedColor="rgba(255, 255, 255, 0.5)"
              accent={accentColor}
              label="On-screen script"
            />
          </View>
        </View>

        <View style={styles.bottom}>
          {link ? (
            <LinkPill
              link={link}
              label="Link in bio"
              color={TT.text}
              mute={TT.mute}
              bg={TT.pill}
              border={TT.pillBorder}
              stats={stats}
              onPress={onPressLink}
            />
          ) : null}
          <Text style={styles.handle} numberOfLines={1}>
            {id.at}
            <Text style={styles.time}>{`  ·  ${timeLabel}`}</Text>
            {stats ? <Text style={styles.time}>{`  ·  ${fmtCompact(stats.views)} views`}</Text> : null}
          </Text>
          <Text style={styles.caption} numberOfLines={2}>
            {caption}
            <HashtagSpans tags={inline} color={TT.text} weight="700" lead={caption ? ' ' : ''} />
          </Text>
          <View style={styles.sound}>
            <Ionicons name="musical-notes" size={13} color={TT.text} />
            <Text style={styles.soundText} numberOfLines={1}>
              {`original sound - ${id.plain}`}
            </Text>
          </View>
        </View>

        <View style={styles.rail} accessible={Boolean(stats)} aria-hidden={stats ? undefined : true} accessibilityLabel={stats ? statsSpeech(stats) : undefined}>
          <RailItem icon="heart" label={stats ? fmtCompact(stats.engagements) : 'Like'} />
          <RailItem icon="chatbubble-ellipses" label="Comment" />
          <RailItem icon="bookmark" label="Save" />
          <RailItem icon="arrow-redo" label="Share" />
        </View>
      </LinearGradient>

      {editable ? (
        <View style={styles.dock}>
          <HashtagsField
            tags={tags}
            onChangeTags={onChangeHashtags}
            color={TT.text}
            mutedColor={TT.mute}
            accent={accentColor}
            fill={TT.field}
            borderColor={TT.border}
          />
        </View>
      ) : null}
    </PreviewShell>
  );
}

const SHADOW = {
  textShadowColor: 'rgba(0, 0, 0, 0.5)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 5,
} as const;

const styles = StyleSheet.create({
  shell: { alignItems: 'center' },
  screen: { width: '100%', maxWidth: SCREEN_MAX_WIDTH, borderRadius: 15, overflow: 'hidden' },

  top: { alignSelf: 'stretch', paddingHorizontal: 12, paddingTop: 12, paddingRight: 68 },
  chip: {
    alignSelf: 'stretch',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
  },
  chipHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chipLabel: { color: TT.cyan, fontSize: 10.5, lineHeight: 14, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  chipText: { color: 'rgba(255, 255, 255, 0.92)', fontSize: 12.5, lineHeight: 17 },

  // 68px each side keeps the centred script clear of the action rail (about 58px wide).
  scriptView: { flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: 'hidden', paddingHorizontal: 68, paddingVertical: 12 },
  scriptEdit: { flexGrow: 1, flexShrink: 0, minHeight: 140, paddingHorizontal: 68, paddingVertical: 12 },
  scriptInner: { alignSelf: 'stretch', marginVertical: 'auto' },
  scriptText: { color: TT.text, fontSize: 19, lineHeight: 26, fontWeight: '800', textAlign: 'center', ...SHADOW },

  bottom: { gap: 6, paddingLeft: 12, paddingRight: 68, paddingBottom: 14 },
  handle: { color: TT.text, fontSize: 16, lineHeight: 21, fontWeight: '800' },
  time: { color: TT.mute, fontSize: 13, fontWeight: '500' },
  caption: { color: TT.text, fontSize: 14, lineHeight: 19 },
  sound: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  soundText: { flexShrink: 1, color: TT.text, fontSize: 12.5, lineHeight: 17 },

  rail: { position: 'absolute', right: 6, bottom: 14, alignItems: 'center', gap: 14 },
  railItem: { alignItems: 'center', gap: 2, minWidth: 44 },
  railLabel: { color: TT.text, fontSize: 11, lineHeight: 15, fontWeight: '700', ...SHADOW },

  dock: { width: '100%', maxWidth: SCREEN_MAX_WIDTH, padding: 12 },
});
