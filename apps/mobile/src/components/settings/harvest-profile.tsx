/**
 * What the harvest unit adds under a LinkedIn / Instagram connector row: a muted status line ("Last harvested 3m ago ·
 * 3 posts"), a small "Profile link" text button and, when expanded, the field where the profile link is saved.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Animated, Platform as RNPlatform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, platformMeta, space } from '@/src/theme';
import type { HarvestPlatformStatus } from '@/src/types';
import { Button, Skeleton, TextField, haptic } from '@/src/ui';
import { HARVEST_LINKS, checkProfileLink, harvestStatusLine, type HarvestPlatform, type StatusLine } from './harvest-logic';

type IconName = ComponentProps<typeof Ionicons>['name'];

const MAX_URL = 500;

const STATUS_ICON: Record<StatusLine['kind'], IconName> = {
  harvested: 'checkmark-circle',
  waiting: 'time-outline',
  'no-link': 'stats-chart-outline',
};

export interface HarvestProfileProps {
  platform: HarvestPlatform;
  /** The platform is connected in this workspace: with no link saved yet, the field then opens by itself. */
  connected: boolean;
  /** The saved profile link, if any. */
  savedUrl: string | null;
  status: HarvestPlatformStatus | null;
  /** Save the link. Resolves null on success, or the message to show under the field. */
  onSave: (platform: HarvestPlatform, url: string) => Promise<string | null>;
}

export function HarvestProfile({ platform, connected, savedUrl, status, onSave }: HarvestProfileProps) {
  const label = platformMeta[platform].label;
  const saved = (savedUrl ?? '').trim();
  const hasLink = saved !== '';

  // `open` is null until the user chooses: the default is open while a connected platform has no link.
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (connected && !hasLink);
  // `draft` is null until the user types: the field then shows the saved link, wherever that came from.
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = checkProfileLink(platform, draft ?? saved);
  const canSave = check.state === 'ok' && check.url !== saved && !saving;
  const line = harvestStatusLine(status, hasLink);
  const toggleTitle = hasLink ? 'Edit profile link' : 'Profile link';

  const hint =
    check.state === 'ok' && check.hostMismatch
      ? `That doesn't look like a ${HARVEST_LINKS[platform].domains[0]} link, but you can still save it.`
      : 'Used to find your posts when you sync real stats.';
  // A server error wins; a link that does not parse is only flagged once the user has left the field.
  const fieldError = error ?? (touched && check.state === 'invalid' ? check.message : null);

  const submit = async () => {
    if (!canSave || check.state !== 'ok') return;
    setSaving(true);
    setError(null);
    let failure: string | null;
    try {
      failure = await onSave(platform, check.url);
    } catch {
      failure = 'Something went wrong. Try again.'; // onSave should not throw, but never leave the spinner stuck
    }
    setSaving(false);
    if (failure) {
      setError(failure);
      return;
    }
    setDraft(null);
    setTouched(false);
    setOpen(false);
  };

  return (
    <View>
      <View style={styles.block}>
        <View style={styles.statusLine} testID={`harvest-status-${platform}`}>
          <Ionicons
            name={STATUS_ICON[line.kind]}
            size={13}
            color={line.kind === 'harvested' ? colors.success : colors.textMute}
            style={styles.statusIcon}
          />
          <Text style={styles.statusText}>{line.text}</Text>
        </View>

        <Pressable
          testID={`harvest-toggle-${platform}`}
          accessibilityRole="button"
          accessibilityLabel={`${toggleTitle} for ${label}`}
          accessibilityState={{ expanded }}
          hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
          onPress={() => {
            haptic.select();
            setOpen(!expanded);
          }}
          style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
        >
          <Ionicons name="link-outline" size={16} color={colors.accent} />
          <Text style={styles.toggleText}>{toggleTitle}</Text>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.accent} />
        </Pressable>
      </View>

      {expanded ? (
        <FadeIn style={styles.form}>
          <TextField
            testID={`harvest-input-${platform}`}
            label="Your profile link"
            accessibilityLabel={`Your profile link, ${label}`}
            value={draft ?? saved}
            onChangeText={(text) => {
              setDraft(text);
              setError(null);
            }}
            onBlur={() => setTouched(true)}
            placeholder={HARVEST_LINKS[platform].placeholder}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="URL"
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
            editable={!saving}
            maxLength={MAX_URL}
            error={fieldError}
            hint={hint}
          />
          <View style={styles.formActions}>
            <Button
              small
              title="Save link"
              icon="checkmark"
              accessibilityLabel={`Save link for ${label}`}
              loading={saving}
              disabled={!canSave}
              onPress={() => void submit()}
            />
          </View>
        </FadeIn>
      ) : null}
    </View>
  );
}

/** Same footprint as the real block (status line + text button), so rows do not jump when the status arrives. */
export function HarvestProfileSkeleton() {
  return (
    <View style={styles.block}>
      <View style={styles.statusLine}>
        <Skeleton width="58%" height={12} style={styles.skeletonLine} />
      </View>
      <View style={styles.toggle}>
        <Skeleton width={116} height={14} />
      </View>
    </View>
  );
}

/** Fades in on mount, like the connect form above it. */
function FadeIn({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: RNPlatform.OS !== 'web' });
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  return <Animated.View style={[style, { opacity }]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  // Full row width, not indented under the handle: at 390px "Add your profile link to pull real stats" then fits one line.
  block: { marginTop: space.sm, gap: 2 },
  statusLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, minHeight: 17 },
  statusIcon: { marginTop: 2 },
  skeletonLine: { marginTop: 2 },
  statusText: { flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 17, color: colors.textMute },
  toggle: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  toggleText: { fontSize: 13.5, fontWeight: '700', color: colors.accent },
  pressed: { opacity: 0.7 },
  form: { marginTop: space.md, gap: space.md },
  formActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
