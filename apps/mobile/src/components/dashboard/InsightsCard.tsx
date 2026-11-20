import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useIsFocused } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, type Insights } from '@/src/api';
import { APP_NAME } from '@/src/config';
import { useAsync } from '@/src/hooks';
import { colors, space, withAlpha } from '@/src/theme';
import { Button, Card, SectionHeader, SkeletonCard, haptic, useToast } from '@/src/ui';
import { updatedLabel } from './insights-model';
import { PlatformRatesBlock, SourcesBlock, ThemesBlock } from './insights-sections';
import { Reveal } from './live';

const DAYS = 30;
/** "Updated 3m ago" is re-evaluated this often while the dashboard is on screen. */
const TICK_MS = 30_000;

const openSettings = () => router.push('/settings');

const messageOf = (e: unknown): string =>
  e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';

/** The one or two sentences of advice, in a highlighted box. */
function Summary({ text }: { text: string }) {
  const body = text.trim();
  return (
    <View style={styles.summary} testID="insights-summary">
      <View style={styles.summaryIcon}>
        <Ionicons name="sparkles" size={15} color={colors.accent} />
      </View>
      <Text style={styles.summaryText}>{body || `Publish a few posts and ${APP_NAME} will learn what works.`}</Text>
    </View>
  );
}

/** "Updated 3m ago". Owns its own clock so the ticking never re-renders the rest of the card. */
function UpdatedAt({ iso }: { iso: string | null }) {
  const focused = useIsFocused();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!focused) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [focused]);

  const text = updatedLabel(iso, now);
  return text ? (
    <Text style={styles.updated} numberOfLines={1}>
      {text}
    </Text>
  ) : null;
}

/** The request failed and there is nothing to show yet: a quiet one-line row, never a blocking error. */
function InsightsError({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <Card tone="outline" padded={false} testID="insights-error">
      <View style={styles.errorRow}>
        <Ionicons name="cloud-offline-outline" size={18} color={colors.textMute} />
        <Text style={styles.errorText} numberOfLines={2}>
          Couldn't load insights
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry"
          accessibilityState={{ disabled: retrying, busy: retrying }}
          disabled={retrying}
          hitSlop={6}
          onPress={() => {
            haptic.tap();
            onRetry();
          }}
          style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
        >
          {retrying ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    </Card>
  );
}

/**
 * "What's working": what the last 30 days of posts say about themes and platforms, with Claude's one-line advice.
 * Self-contained (the dashboard only passes its reveal slot). The data re-fetches quietly whenever the tab regains
 * focus, so there is no polling. Renders nothing at all when the server has no insights API.
 */
function InsightsCardImpl({ revealIndex }: { revealIndex?: number }) {
  const toast = useToast();
  const { data, error, refreshing, reload, setData } = useAsync<Insights | null>(() => api.getInsights(DAYS), []);
  const [relearning, setRelearning] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const retry = useCallback(() => {
    void reload();
  }, [reload]);

  /** "Re-learn": ask the server to recompute from the latest numbers, then swap the card's data in place. */
  const relearn = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setRelearning(true);
    try {
      const next = await api.refreshInsights();
      if (next) {
        setData(next);
        haptic.success();
        toast.show('Re-learned from your latest numbers');
      } else {
        // The endpoint is gone (null): say so, then reload so the card hides itself like it would on a fresh load.
        toast.show("Insights aren't available on this server", 'info');
        void reload();
      }
    } catch (e) {
      toast.show(messageOf(e), 'error');
    } finally {
      busy.current = false;
      if (alive.current) setRelearning(false);
    }
  }, [reload, setData, toast]);

  // The server has no insights API: render nothing, not even a wrapper (it would add a gap to the dashboard column).
  if (data === null) return null;

  // One Reveal for every state, so the card fades in with the rest of the dashboard exactly once: the skeleton, the
  // error row and the finished card swap inside it (a Reveal that mounted only when the data arrived would sit
  // invisible for its stagger delay while the skeleton had already vanished).
  return (
    <Reveal index={revealIndex ?? 6}>
      {data === undefined ? (
        // First load, or the first load failed: never blocks the rest of the dashboard.
        error ? (
          <InsightsError retrying={refreshing} onRetry={retry} />
        ) : (
          <SkeletonCard lines={4} />
        )
      ) : (
        <Card style={styles.card} testID="insights-card">
          <SectionHeader title="What's working" subtitle="Last 30 days, learned from your posts" />
          <Summary text={data.summary} />
          <ThemesBlock themes={data.top_themes} />
          <PlatformRatesBlock rates={data.by_platform} />
          <SourcesBlock sources={data.sources} onOpenSettings={openSettings} />
          <View style={styles.footer}>
            <View style={styles.footerLeft}>
              <UpdatedAt iso={data.generated_at} />
            </View>
            <Button
              title="Re-learn"
              icon="refresh"
              variant="secondary"
              small
              loading={relearning}
              onPress={relearn}
              testID="insights-relearn"
            />
          </View>
        </Card>
      )}
    </Reveal>
  );
}

/** Memoised: the dashboard re-renders every few seconds with the same props, and this card has its own data. */
export const InsightsCard = memo(InsightsCardImpl);

const styles = StyleSheet.create({
  card: { gap: space.lg },
  summary: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: space.md,
    borderRadius: 14,
    backgroundColor: withAlpha(colors.accent, 0.12),
    borderWidth: 1,
    borderColor: withAlpha(colors.accent, 0.35),
  },
  summaryIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(colors.accent, 0.2),
  },
  summaryText: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14.5, lineHeight: 21, fontWeight: '600', paddingTop: 3 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  footerLeft: { flex: 1, minWidth: 0 },
  updated: { color: colors.textMute, fontSize: 12.5, fontWeight: '600' },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 52,
    paddingLeft: space.lg,
    paddingRight: space.sm,
  },
  errorText: { flex: 1, minWidth: 0, color: colors.textDim, fontSize: 14, fontWeight: '600' },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: space.md },
  retryText: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
