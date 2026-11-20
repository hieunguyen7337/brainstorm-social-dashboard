import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRef } from 'react';
import { StyleSheet, Text, View, type TextInput } from 'react-native';

import { fmtCompact } from '@/src/format';
import { colors } from '@/src/theme';
import { PlatformBadge } from '@/src/ui/PlatformIcon';

import { HashtagsField, PreviewText } from './fields';
import {
  LinkCard,
  PreviewShell,
  cleanTags,
  identityOf,
  statsSpeech,
  withoutTrackedLink,
  type IonName,
  type LinkPalette,
} from './parts';
import type { PreviewProps } from './types';

/** Reddit dark palette. */
const R = {
  bg: '#1a1a1b',
  rail: '#161617',
  border: '#343536',
  text: '#d7dadc',
  mute: '#818384',
  orange: '#ff4500',
  chip: '#272729',
  link: '#4fbcff',
} as const;

const LINK_PALETTE: LinkPalette = { bg: R.bg, border: R.border, text: R.text, mute: R.mute, cta: R.link };

const DEFAULT_SUBREDDIT = 'smallbusiness';

/** The first line of `content` is the post title, everything after it (minus blank lines) the body. */
export function splitRedditPost(content: string): { title: string; body: string } {
  const nl = content.indexOf('\n');
  if (nl === -1) return { title: content, body: '' };
  return { title: content.slice(0, nl), body: content.slice(nl + 1).replace(/^(?:[ \t]*\n)+/, '') };
}

/** Inverse of `splitRedditPost`: title, blank line, body. */
export function joinRedditPost(title: string, body: string): string {
  return body.length > 0 ? `${title}\n\n${body}` : title;
}

function FooterItem({ icon, label }: { icon: IonName; label: string }) {
  return (
    <View style={styles.footerItem}>
      <Ionicons name={icon} size={18} color={R.mute} />
      <Text style={styles.footerLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/**
 * Reddit post: vote column, "r/sub · Posted by u/handle · time", bold title (first line of the content), body,
 * flair chips for hashtags, link card, comments / share / award footer. Editing is two stacked fields over one
 * string (title, then body); Enter in the title moves on to the body.
 */
export function RedditPreview({
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
  subreddit,
  onChangeContent,
  onChangeHashtags,
  onPressLink,
}: PreviewProps) {
  const id = identityOf(brandName, handle);
  const small = compact && !editable;
  const text = withoutTrackedLink(content, link);
  const tags = cleanTags(hashtags);
  const sub = (subreddit ?? '').replace(/^\/?r\//i, '').trim() || DEFAULT_SUBREDDIT;
  const { title, body } = splitRedditPost(text);
  const bodyRef = useRef<TextInput>(null);
  const scored = Boolean(stats);

  const onTitle = (t: string) => {
    const nl = t.indexOf('\n');
    if (nl === -1) {
      onChangeContent?.(joinRedditPost(t, body));
      return;
    }
    // Enter (or a multi-line paste) in the title: the rest of the text becomes the start of the body.
    const rest = t.slice(nl + 1);
    const merged = body.length > 0 ? (rest.length > 0 ? `${rest}\n${body}` : body) : rest;
    onChangeContent?.(joinRedditPost(t.slice(0, nl), merged));
    bodyRef.current?.focus();
  };
  const onBody = (b: string) => onChangeContent?.(joinRedditPost(title, b));

  const flair = small ? tags.slice(0, 3) : tags;

  return (
    <PreviewShell background={R.bg} borderColor={R.border}>
      <View style={styles.row}>
        <View
          style={styles.votes}
          accessible={scored}
          aria-hidden={scored ? undefined : true}
          accessibilityLabel={stats ? statsSpeech(stats) : undefined}
        >
          <MaterialCommunityIcons
            name={scored ? 'arrow-up-bold' : 'arrow-up-bold-outline'}
            size={24}
            color={scored ? R.orange : R.mute}
          />
          <Text style={[styles.score, scored && styles.scoreOn]} numberOfLines={1}>
            {stats ? fmtCompact(stats.engagements) : 'Vote'}
          </Text>
          <MaterialCommunityIcons name="arrow-down-bold-outline" size={24} color={R.mute} />
        </View>

        <View style={styles.main}>
          <View style={styles.meta}>
            <PlatformBadge platform="reddit" size={22} solid />
            <Text style={styles.metaText} numberOfLines={2}>
              <Text style={styles.sub}>{`r/${sub}`}</Text>
              <Text style={styles.metaMute}>{` · Posted by u/${id.plain} · ${timeLabel}`}</Text>
            </Text>
          </View>

          <PreviewText
            value={title}
            editable={editable}
            onChangeText={onTitle}
            placeholder="Post title"
            style={styles.title}
            mutedColor={R.mute}
            accent={accentColor}
            label="Post title"
            maxLines={small ? 3 : undefined}
          />

          {editable || body.trim().length > 0 ? (
            <PreviewText
              value={body}
              editable={editable}
              onChangeText={onBody}
              placeholder="Add body text (optional)"
              style={styles.body}
              mutedColor={R.mute}
              accent={accentColor}
              label="Post body"
              maxLines={small ? 3 : undefined}
              inputRef={bodyRef}
            />
          ) : null}

          {editable ? (
            <HashtagsField
              tags={tags}
              onChangeTags={onChangeHashtags}
              color={R.link}
              mutedColor={R.mute}
              accent={accentColor}
              fill={R.chip}
              borderColor={R.border}
            />
          ) : flair.length > 0 ? (
            <View style={styles.flair}>
              {flair.map((t) => (
                <View key={t} style={styles.chip}>
                  <Text style={styles.chipText}>{`#${t}`}</Text>
                </View>
              ))}
            </View>
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

          <View style={styles.footer} aria-hidden>
            <FooterItem icon="chatbubble-outline" label="Comments" />
            <FooterItem icon="arrow-redo-outline" label="Share" />
            <FooterItem icon="medal-outline" label="Award" />
            {stats ? <FooterItem icon="eye-outline" label={fmtCompact(stats.views)} /> : null}
          </View>
        </View>
      </View>
    </PreviewShell>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch' },
  votes: { width: 48, alignItems: 'center', paddingTop: 10, gap: 2, backgroundColor: R.rail },
  score: { color: R.mute, fontSize: 12.5, lineHeight: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  scoreOn: { color: R.orange },
  main: { flex: 1, minWidth: 0, paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 6, gap: 8 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 16 },
  sub: { color: R.text, fontWeight: '700' },
  metaMute: { color: R.mute },
  title: { color: R.text, fontSize: 18, lineHeight: 24, fontWeight: '700' },
  body: { color: R.text, fontSize: 14, lineHeight: 20 },
  flair: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: R.chip, borderWidth: 1, borderColor: R.border },
  chipText: { color: R.mute, fontSize: 12, lineHeight: 16, fontWeight: '600' },
  link: { borderRadius: 10, marginTop: 2 },
  footer: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 4, marginLeft: -6, marginTop: 2 },
  footerItem: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 6 },
  footerLabel: { color: R.mute, fontSize: 12, lineHeight: 16, fontWeight: '700' },
});
