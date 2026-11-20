import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { router } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { api, ApiError, PLATFORMS, type Platform, type Post } from '@/src/api';
import { StartRoom } from '@/src/components/room/StartRoom';
import { timeAgo, truncate } from '@/src/format';
import { colors, platformMeta, radius, space, type as t } from '@/src/theme';
import { Button, Card, Chip, ChipRow, PlatformBadge, PlatformIcon, SectionHeader, Skeleton, TextField, haptic, useToast } from '@/src/ui';
import { laneCounts, latestDrafts, type LaneCount } from './boardModel';
import { firstLine } from './model';

/** The two platforms the quick box starts with. */
const DEFAULT_PLATFORMS: readonly Platform[] = ['linkedin', 'instagram'];
const MAX_BRIEF = 1000;
const MAX_DRAFTS = 3;
/** Shown (neutral, not an error) when the API answered with the template fallback instead of Claude. */
const AI_BUSY_TEXT = 'AI busy, using a template';

const openQueue = (tab: 'drafts' | 'scheduled' | 'published' = 'drafts') =>
  router.push({ pathname: '/queue', params: { tab } });

const messageOf = (e: unknown): string =>
  e instanceof ApiError && e.message ? e.message : 'Something went wrong. Please try again.';

/**
 * The "Generate" column of the wide board: "Start a room" on top, a quick-generate box (brief + platform chips +
 * Generate), the newest drafts, and the five channel lanes with their draft / published counts.
 */
export function GenerateCard({
  posts,
  loading,
  onGenerated,
  style,
}: {
  /** Every post (the lanes count them). Undefined until the first response. */
  posts: Post[] | undefined;
  loading: boolean;
  /** Called with the freshly saved drafts so the board can show them before the next poll. */
  onGenerated: (created: Post[]) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const toast = useToast();
  const [brief, setBrief] = useState('');
  const [platforms, setPlatforms] = useState<Platform[]>([...DEFAULT_PLATFORMS]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last batch came from the template fallback (no AI available): a neutral line, never an error.
  const [template, setTemplate] = useState(false);
  const requesting = useRef(false);

  const toggle = (p: Platform) =>
    setPlatforms((cur) => PLATFORMS.filter((x) => (x === p ? !cur.includes(p) : cur.includes(x))));

  const generate = async () => {
    if (requesting.current || platforms.length === 0) return;
    requesting.current = true;
    setBusy(true);
    setError(null);
    setTemplate(false);
    try {
      const res = await api.generate({ platforms, brief: brief.trim() || undefined });
      if (!Array.isArray(res.posts) || res.posts.length === 0) throw new Error('No posts came back');
      onGenerated(res.posts);
      setBrief('');
      setTemplate(res.ai_used === false);
      haptic.success();
      const n = res.posts.length;
      toast.show(`Drafted ${n} ${n === 1 ? 'post' : 'posts'}`);
    } catch (e) {
      setError(messageOf(e));
      haptic.warn();
    } finally {
      requesting.current = false;
      setBusy(false);
    }
  };

  const drafts = useMemo(() => latestDrafts(posts ?? [], MAX_DRAFTS), [posts]);
  const lanes = useMemo(() => laneCounts(posts ?? []), [posts]);
  const count = platforms.length;

  return (
    <Card style={[styles.card, style]}>
      <StartRoom compact />
      <View style={styles.divider} />

      <SectionHeader title="Generate" subtitle="Draft posts in one tap" />

      <TextField
        value={brief}
        onChangeText={setBrief}
        placeholder="What should we post?"
        accessibilityLabel="Brief"
        maxLength={MAX_BRIEF}
        returnKeyType="go"
        onSubmitEditing={() => void generate()}
      />
      <ChipRow style={styles.chips}>
        {PLATFORMS.map((p) => (
          <Chip
            key={p}
            small
            platform={p}
            label={platformMeta[p].label}
            selected={platforms.includes(p)}
            onPress={() => toggle(p)}
          />
        ))}
      </ChipRow>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {template && !error ? (
        <Text testID="generate-template-note" style={styles.templateNote}>
          {AI_BUSY_TEXT}
        </Text>
      ) : null}
      <Button
        title={busy ? 'Generating...' : count > 0 ? `Generate ${count} ${count === 1 ? 'post' : 'posts'}` : 'Pick a platform'}
        icon="sparkles"
        full
        loading={busy}
        disabled={count === 0 || busy}
        onPress={() => void generate()}
      />

      <View style={styles.divider} />
      <Text style={t.label}>Latest drafts</Text>
      {!posts ? (
        loading ? (
          <DraftsSkeleton />
        ) : (
          <Text style={[t.dim, styles.empty]}>Drafts will show up here.</Text>
        )
      ) : drafts.length === 0 ? (
        <Text style={[t.dim, styles.empty]}>No drafts yet. Write a brief above and hit Generate.</Text>
      ) : (
        <View>
          {drafts.map((post) => (
            <DraftRow key={post.id} post={post} />
          ))}
        </View>
      )}

      <View style={styles.divider} />
      <Text style={t.label}>Channel lanes</Text>
      <View style={styles.lanes}>
        {lanes.map((row) => (
          <LaneRow key={row.lane.key} row={row} />
        ))}
      </View>
    </Card>
  );
}

function DraftRow({ post }: { post: Post }) {
  const text = truncate(firstLine(post.content).replace(/^Hook \([^)]*\):\s*/, ''), 110);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${platformMeta[post.platform].label} draft: ${text}`}
      onPress={() => openQueue('drafts')}
      style={({ pressed }) => [styles.draft, pressed && styles.pressed]}
    >
      <PlatformBadge platform={post.platform} size={28} />
      <View style={styles.draftBody}>
        <Text style={styles.draftText} numberOfLines={2}>
          {text}
        </Text>
        <Text style={t.small}>{timeAgo(post.created_at)}</Text>
      </View>
    </Pressable>
  );
}

function DraftsSkeleton() {
  return (
    <View style={styles.skeleton}>
      {[0, 1].map((i) => (
        <View key={i} style={styles.draft}>
          <Skeleton width={28} height={28} rounded={14} />
          <View style={styles.draftBody}>
            <Skeleton width="90%" height={12} />
            <Skeleton width="30%" height={10} />
          </View>
        </View>
      ))}
    </View>
  );
}

function LaneRow({ row }: { row: LaneCount }) {
  const { lane, drafts, scheduled, published } = row;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const counts = [plural(drafts, 'draft'), ...(scheduled > 0 ? [`${scheduled} scheduled`] : []), `${published} published`];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${lane.label} lane: ${counts.join(', ')}`}
      onPress={() => openQueue(drafts > 0 || published === 0 ? 'drafts' : 'published')}
      style={({ pressed }) => [styles.lane, pressed && styles.pressed]}
    >
      <View style={styles.laneIcons}>
        {lane.platforms.map((p) => (
          <PlatformIcon key={p} platform={p} size={15} />
        ))}
        {lane.threads ? <FontAwesome6 name="threads" size={15} color={colors.text} brand /> : null}
      </View>
      <View style={styles.laneBody}>
        <Text style={styles.laneName} numberOfLines={1}>
          {lane.label}
        </Text>
        <Text style={styles.laneCounts} numberOfLines={2}>
          {counts.join(' · ')}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  chips: { gap: 6 },
  error: { color: colors.danger, fontSize: 12.5, fontWeight: '600' },
  templateNote: { color: colors.textDim, fontSize: 12.5, fontWeight: '500' },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 2 },
  empty: { paddingVertical: space.xs },
  pressed: { opacity: 0.85 },
  skeleton: { gap: space.sm },
  draft: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: 6 },
  draftBody: { flex: 1, minWidth: 0, gap: 3 },
  draftText: { color: colors.text, fontSize: 13.5, lineHeight: 18, fontWeight: '500' },
  lanes: { gap: 6 },
  lane: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 7,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.cardHi,
    borderWidth: 1,
    borderColor: colors.border,
  },
  laneIcons: { width: 38, flexDirection: 'row', alignItems: 'center', gap: 5 },
  laneBody: { flex: 1, minWidth: 0, gap: 1 },
  laneName: { color: colors.text, fontSize: 13.5, fontWeight: '700' },
  laneCounts: { color: colors.textDim, fontSize: 12, lineHeight: 16 },
});
