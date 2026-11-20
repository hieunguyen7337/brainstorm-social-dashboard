import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius, space, type as t, withAlpha } from '@/src/theme';
import type { InsightsResponse, ThemeInsight } from '@/src/types';
import { Badge, Button, Card, SectionHeader, Skeleton } from '@/src/ui';
import { LIFT_COLOR, fmtLift, liftTone } from './boardModel';

const MAX_THEMES = 6;

/** Jev AI sorts posts into your themes: this is how many posts each one got and how it performs against your average. */
export function ThemesCard({
  insights,
  loading,
  error,
  onRetry,
  style,
}: {
  insights: InsightsResponse | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const themes = Array.isArray(insights?.themes) ? insights.themes.slice(0, MAX_THEMES) : [];
  const summary = typeof insights?.summary === 'string' ? insights.summary.trim() : '';

  return (
    <Card style={[styles.card, style]}>
      <SectionHeader title="Themes (Jev AI)" subtitle="Post count and lift vs your average, last 30 days" />
      {!insights ? (
        error && !loading ? (
          <View style={styles.message}>
            <Ionicons name="cloud-offline-outline" size={18} color={colors.danger} />
            <Text style={[t.dim, styles.messageText]}>Couldn't load theme insights.</Text>
            <Button title="Retry" variant="secondary" small onPress={onRetry} />
          </View>
        ) : (
          <ThemesSkeleton />
        )
      ) : themes.length === 0 ? (
        <View style={styles.message}>
          <Ionicons name="color-palette-outline" size={18} color={colors.textMute} />
          <Text style={[t.dim, styles.messageText]}>No themes yet. Add content themes in Settings and Jev will sort your posts.</Text>
          <Button title="Settings" variant="secondary" small onPress={() => router.push('/settings')} />
        </View>
      ) : (
        <View>
          {themes.map((theme, i) => (
            <ThemeLine key={theme.theme_id} theme={theme} last={i === themes.length - 1} />
          ))}
        </View>
      )}
      {summary ? (
        <Text style={styles.summary} numberOfLines={4}>
          {summary}
        </Text>
      ) : null}
    </Card>
  );
}

function ThemeLine({ theme, last }: { theme: ThemeInsight; last: boolean }) {
  const tone = liftTone(theme.lift);
  const color = LIFT_COLOR[tone];
  const byJev = (theme.classifiers?.jev ?? 0) > 0;
  const posts = `${theme.posts} ${theme.posts === 1 ? 'post' : 'posts'}`;
  const lift = theme.posts > 0 ? fmtLift(theme.lift) : '';

  return (
    <View
      style={[styles.row, !last && styles.divider]}
      accessible
      accessibilityLabel={`${theme.name}: ${posts}${lift ? `, ${lift} versus your average` : ''}${byJev ? ', classified by Jev' : ''}`}
    >
      <View style={[styles.swatch, { backgroundColor: theme.color }]} />
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {theme.name}
        </Text>
        <View style={styles.meta}>
          <Text style={t.small}>{posts}</Text>
          {byJev ? <Badge label="classified by Jev" tone="accent" icon="sparkles" /> : null}
        </View>
      </View>
      {lift ? (
        <View style={[styles.lift, { backgroundColor: withAlpha(color, 0.14) }]}>
          {tone === 'flat' ? null : <Ionicons name={tone === 'up' ? 'arrow-up' : 'arrow-down'} size={11} color={color} />}
          <Text style={[styles.liftText, { color }]}>{lift}</Text>
        </View>
      ) : (
        <Text style={t.small}>no posts</Text>
      )}
    </View>
  );
}

function ThemesSkeleton() {
  return (
    <View style={styles.skeleton}>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={styles.row}>
          <Skeleton width={12} height={12} rounded={6} />
          <View style={styles.body}>
            <Skeleton width={i % 2 ? '55%' : '70%'} height={13} />
            <Skeleton width="30%" height={10} />
          </View>
          <Skeleton width={52} height={22} rounded={11} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 9 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  swatch: { width: 12, height: 12, borderRadius: 6 },
  body: { flex: 1, minWidth: 0, gap: 3 },
  name: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm, rowGap: 4 },
  lift: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  liftText: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  summary: { ...t.small, marginTop: 'auto', paddingTop: space.sm },
  message: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm, paddingVertical: space.md },
  messageText: { flex: 1, minWidth: 140 },
  skeleton: { gap: 0 },
});
