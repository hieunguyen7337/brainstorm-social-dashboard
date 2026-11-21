import Ionicons from '@expo/vector-icons/Ionicons';
import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, platformMeta, radius, space, type as t, withAlpha } from '@/src/theme';
import type { Post } from '@/src/types';
import { PlatformIcon, haptic } from '@/src/ui';

import { IgPostSheet } from '@/src/igPost/IgPostSheet';
import { LiPostSheet } from '@/src/liPost/LiPostSheet';

import { useShare, type ShareAction, type ShareWiring } from './useShare';

export interface ShareButtonsProps extends ShareWiring {
  post: Post;
  /** Narrow card: the buttons stack full width instead of sharing a row. */
  compact?: boolean;
  /** 36 px tall buttons (Queue cards) instead of 48. */
  small?: boolean;
  /** The card is busy with something else (a request in flight, "Publish all" running). */
  disabled?: boolean;
}

/** Brand tint of a button: Threads has no entry in `platformMeta`, it borrows X's light tone. */
const tintOf = (action: ShareAction): string => platformMeta[action.key === 'threads' ? 'x' : action.key].color;

function ActionIcon({ action, size, color }: { action: ShareAction; size: number; color: string }) {
  if (action.mode === 'copy') return <Ionicons name="copy-outline" size={size} color={color} />;
  if (action.mode === 'demo-refresh') return <Ionicons name="refresh-outline" size={size} color={color} />;
  if (action.key === 'threads') return <FontAwesome6 name="threads" size={size} color={color} brand />;
  return <PlatformIcon platform={action.key} size={size} color={color} />;
}

function ShareButton({
  action,
  busy,
  disabled,
  small,
  stacked,
  onPress,
}: {
  action: ShareAction;
  busy: boolean;
  disabled: boolean;
  small: boolean;
  stacked: boolean;
  onPress: () => void;
}) {
  const tint = tintOf(action);
  const inactive = disabled || busy;
  return (
    <Pressable
      testID={action.testID}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        small ? styles.small : styles.regular,
        stacked ? styles.stacked : styles.inline,
        { borderColor: withAlpha(tint, 0.55), backgroundColor: withAlpha(tint, 0.12) },
        inactive && styles.inactive,
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.text} />
      ) : (
        <ActionIcon action={action} size={small ? 15 : 17} color={tint} />
      )}
      <Text style={[styles.label, small && styles.labelSmall]} numberOfLines={1}>
        {action.label}
      </Text>
    </Pressable>
  );
}

/**
 * "Post it for real": the buttons that open the network's own composer with this post's text (or copy the caption for
 * Instagram and TikTok) and then mark the post published. See `useShare` for the flow and its fallbacks.
 */
export function ShareButtons({ post, compact = false, small = false, disabled = false, ...wiring }: ShareButtonsProps) {
  const share = useShare(post, wiring);
  return (
    <View style={styles.wrap} testID="share-buttons">
      {post.platform === 'instagram' ? (
        <View style={styles.imageRow}>
          {share.image ? <Image source={{ uri: share.image.uri }} style={styles.thumb} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={share.image ? 'Change image' : 'Add image'}
            onPress={() => void share.addImage()}
            disabled={disabled || share.busyKey !== null}
            style={styles.imageBtn}
            testID="add-image"
          >
            <Ionicons name="image-outline" size={18} color={colors.text} />
            <Text style={[t.h3, { fontSize: 14 }]}>{share.image ? 'Change image' : 'Add image'}</Text>
          </Pressable>
          {share.image ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Remove image" onPress={share.removeImage} hitSlop={8}>
              <Text style={[t.small, { color: colors.textDim }]}>Remove</Text>
            </Pressable>
          ) : (
            <Text style={[t.small, { flex: 1 }]}>Or Pulse makes one from the text.</Text>
          )}
        </View>
      ) : null}
      <View style={compact ? styles.column : styles.row}>
        {share.actions.map((action) => (
          <ShareButton
            key={action.key}
            action={action}
            busy={share.busyKey === action.key}
            disabled={disabled || share.busyKey !== null}
            small={small}
            stacked={compact}
            onPress={() => share.press(action)}
          />
        ))}
      </View>
      {share.note ? (
        <Text style={[t.small, styles.note]} testID="share-note">
          {share.note}
        </Text>
      ) : null}
      {share.links.map((link) => (
        <Pressable
          key={link.key}
          testID="share-link"
          accessibilityRole="link"
          accessibilityLabel={`Open ${link.name}`}
          onPress={() => share.openLink(link)}
          style={styles.fallback}
        >
          <Ionicons name="open-outline" size={15} color={colors.accent} />
          <Text style={styles.fallbackText} numberOfLines={2}>
            {`Popup blocked. Tap to open ${link.name}`}
          </Text>
        </Pressable>
      ))}
      {share.igSheet ? <IgPostSheet {...share.igSheet} /> : null}
      {share.liSheet ? <LiPostSheet {...share.liSheet} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  imageRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: colors.cardHi },
  imageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.cardHi,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  column: { gap: space.sm },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.md,
  },
  regular: { minHeight: 48, paddingHorizontal: 18 },
  small: { minHeight: 36, paddingHorizontal: 14, borderRadius: 12 },
  // In a row the buttons take their natural width and share what is left; the row wraps when they do not fit.
  inline: { flexGrow: 1 },
  stacked: { alignSelf: 'stretch' },
  inactive: { opacity: 0.5 },
  pressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  label: { fontSize: 15.5, fontWeight: '700', letterSpacing: 0.1, color: colors.text },
  labelSmall: { fontSize: 13.5 },
  note: { color: colors.textMute },
  fallback: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  fallbackText: { flexShrink: 1, fontSize: 13, fontWeight: '700', color: colors.accent, textDecorationLine: 'underline' },
});
