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
import { LinkedInVisual } from './visual-frames';
import { Collapsible, LinkStrip } from './visual-linkedin';

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

/** Lines of post text a read-only card shows before "…see more" (list cards show fewer). */
const FULL_LINES = 8;
const SMALL_LINES = 5;
const TEXT_LINE_HEIGHT = 20;

/** Blank lines between paragraphs collapse on list cards, so more copy fits into few lines. */
const squeeze = (t: string): string => t.replace(/\n(?:[ \t]*\n)+/g, '\n');

/**
 * LinkedIn post: square avatar, followers + time, "+ Follow", paragraphs that fold to "…see more", blue hashtags, the
 * visual plan as a 1.91:1 image banner over the tracked-link strip, reaction counts, and the Like / Comment / Repost /
 * Send bar.
 */
export function LinkedInPreview({
  content,
  hashtags,
  mediaPrompt,
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
  onChangeMediaPrompt,
  onPressLink,
}: PreviewProps) {
  const id = identityOf(brandName, handle);
  const small = compact && !editable;
  const text = withoutTrackedLink(content, link);
  const tags = cleanTags(hashtags);
  const inline = tagsNotIn(tags, text);
  const plan = mediaPrompt ?? '';
  // While editing the banner stays even when the plan is empty, so a plan can be added (and the field never
  // unmounts under the user's fingers when they delete the last character).
  const showPlan = editable || plan.trim().length > 0;
  const followersLine =
    typeof followers === 'number' && Number.isFinite(followers)
      ? `${fmtInt(followers)} follower${Math.round(followers) === 1 ? '' : 's'}`
      : '';

  const postText = (
    <PreviewText
      value={small ? squeeze(text) : text}
      editable={editable}
      onChangeText={onChangeContent}
      placeholder="What do you want to talk about?"
      style={styles.text}
      mutedColor={L.mute}
      accent={accentColor}
      label="Post text"
      suffix={<HashtagSpans tags={inline} color={L.blue} lead={'\n\n'} weight="600" />}
    />
  );

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
        <View style={styles.headActions} aria-hidden>
          <View style={styles.follow}>
            <Ionicons name="add" size={19} color={L.blue} />
            <Text style={styles.followText}>Follow</Text>
          </View>
          <Ionicons name="ellipsis-horizontal" size={20} color={L.mute} />
        </View>
      </View>

      <View style={styles.body}>
        {editable ? (
          <>
            {postText}
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
          </>
        ) : (
          <Collapsible
            lines={small ? SMALL_LINES : FULL_LINES}
            lineHeight={TEXT_LINE_HEIGHT}
            interactive={!small}
            background={L.bg}
            color={L.mute}
          >
            {postText}
          </Collapsible>
        )}
      </View>

      {showPlan ? (
        <LinkedInVisual
          plan={plan}
          accentColor={accentColor}
          editable={editable}
          compact={small}
          onChangePlan={onChangeMediaPrompt}
        />
      ) : null}

      {link ? (
        small ? (
          <View style={[styles.linkPad, showPlan && styles.linkPadBelowPlan]}>
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
        ) : showPlan ? (
          <LinkStrip link={link} title={id.name} stats={stats} palette={LINK_PALETTE} onPress={onPressLink} />
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
            <Ionicons name={r.icon} size={21} color={L.mute} />
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
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 16, paddingTop: 14 },
  headText: { flex: 1, minWidth: 0, gap: 1 },
  name: { color: L.text, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  sub: { color: L.mute, fontSize: 12, lineHeight: 16 },
  // Lifted a few px so "+ Follow" and the menu line up with the name rather than the middle of the header.
  headActions: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -6, marginRight: -2, flexShrink: 0 },
  follow: { flexDirection: 'row', alignItems: 'center', height: 32, paddingLeft: 2, paddingRight: 4 },
  followText: { color: L.blue, fontSize: 14.5, lineHeight: 20, fontWeight: '700' },

  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14 },
  text: { color: L.text, fontSize: 14, lineHeight: TEXT_LINE_HEIGHT },
  tagsField: { marginTop: 14 },

  linkPad: { paddingHorizontal: 16, paddingBottom: 12 },
  linkPadBelowPlan: { paddingTop: 12 },
  linkRow: { borderRadius: 10 },

  counts: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  reactions: { flexDirection: 'row', alignItems: 'center' },
  dotOverlap: { marginLeft: -7, marginRight: 6 },
  countText: { color: L.mute, fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },

  divider: { marginHorizontal: 16 },
  // Icon above label, as in the LinkedIn app: four labels fit any phone width without truncating ("Comm...").
  bar: { flexDirection: 'row', paddingHorizontal: 4, paddingVertical: 2 },
  barItem: { flex: 1, minHeight: 54, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 6 },
  barLabel: { color: L.mute, fontSize: 12, lineHeight: 16, fontWeight: '600' },
});
