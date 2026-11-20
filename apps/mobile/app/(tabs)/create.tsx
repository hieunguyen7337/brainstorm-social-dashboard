import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';

import { api } from '@/src/api';
import { BriefFields } from '@/src/components/create/BriefFields';
import { errorMessage } from '@/src/components/create/errors';
import { GeneratingState } from '@/src/components/create/GeneratingState';
import { TREND_FETCH, firstParam, orderLike, type Batch, type TrendChoice } from '@/src/components/create/logic';
import { PlatformPicker } from '@/src/components/create/PlatformPicker';
import { ResultView } from '@/src/components/create/ResultView';
import { ThemePicker } from '@/src/components/create/ThemePicker';
import { TrendPicker } from '@/src/components/create/TrendPicker';
import { UsageLine } from '@/src/components/create/UsageLine';
import { APP_NAME, MAX_CONTENT_WIDTH } from '@/src/config';
import { useAsync } from '@/src/hooks';
import { useSession } from '@/src/session';
import { colors, space } from '@/src/theme';
import { PRIMARY_PLATFORMS, type Platform, type Trend } from '@/src/types';
import { Button, Card, ErrorState, Screen, haptic } from '@/src/ui';

type Phase = 'form' | 'generating' | 'result';

/**
 * Generate: pick platforms, a theme, optionally a trend and a brief, press Generate and get one platform-native post
 * per platform. All state lives here, so the form survives switching tabs and the result survives too.
 */
export default function CreateScreen() {
  const { workspace } = useSession();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ trendId?: string; trendTitle?: string }>();
  const trendIdParam = firstParam(params.trendId);
  const trendTitleParam = firstParam(params.trendTitle);

  // ---- data: each piece loads on its own and degrades softly; none of it can block Generate -------------------------
  const connections = useAsync(() => api.listConnections(), []);
  const themes = useAsync(() => api.listThemes(), []);
  const usage = useAsync(() => api.getAiUsage(), []);
  // Trends are fetched lazily: when the list is first opened, or to resolve a trend arriving from the Trends tab.
  const [trendsWanted, setTrendsWanted] = useState(false);
  const trends = useAsync(() => api.listTrends({ limit: TREND_FETCH }), [], { enabled: trendsWanted });

  // ---- form ------------------------------------------------------------------------------------------------------
  /** null until the user touches the chips: until then LinkedIn and Instagram are preselected (founders' priority). */
  const [picked, setPicked] = useState<Platform[] | null>(null);
  const [themeId, setThemeId] = useState<string | null>(null);
  const [trend, setTrend] = useState<TrendChoice | null>(null);
  const [trendOpen, setTrendOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [tone, setTone] = useState<string | null>(null);

  // ---- generation flow -------------------------------------------------------------------------------------------
  const [phase, setPhase] = useState<Phase>('form');
  const [batch, setBatch] = useState<Batch | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const requesting = useRef(false);

  // ---- derived ---------------------------------------------------------------------------------------------------
  const platforms = useMemo<Platform[]>(() => picked ?? [...PRIMARY_PLATFORMS], [picked]);

  const activeThemes = useMemo(() => (themes.data ?? []).filter((x) => x.active), [themes.data]);
  const theme = activeThemes.find((x) => x.id === themeId) ?? null;

  // The chosen trend, with its full record once it is known (picked from the list, or found in it).
  const trendView = useMemo<TrendChoice | null>(() => {
    if (!trend) return null;
    const full = trend.full ?? trends.data?.find((x) => x.id === trend.id);
    return { id: trend.id, title: full?.title ?? trend.title, full };
  }, [trend, trends.data]);

  const trendsLoading = trendsWanted && !trends.data && !trends.error;
  const trendsFailed = !!trends.error && !trends.data;

  // ---- arriving from the Trends tab -----------------------------------------------------------------------------------
  // The navigator's own typing knows no route params, so keep a narrow view of the one call we need.
  const navRef = useRef(navigation as unknown as { setParams: (next: Record<string, string | undefined>) => void });
  navRef.current = navigation as unknown as { setParams: (next: Record<string, string | undefined>) => void };
  useEffect(() => {
    if (!trendIdParam) return;
    setTrend({ id: trendIdParam, title: trendTitleParam ?? 'Selected trend' });
    setTrendsWanted(true);
    setTrendOpen(false);
    // A new trend means a new post: leave a finished result behind (its drafts are already in the queue).
    setBatch(null);
    setPhase((p) => (p === 'result' ? 'form' : p));
    // Consume the params, so sending the same trend here again later registers as a change.
    try {
      navRef.current.setParams({ trendId: undefined, trendTitle: undefined });
    } catch {
      // Not attached to a navigator right now: nothing to clear.
    }
  }, [trendIdParam, trendTitleParam]);

  // ---- handlers ---------------------------------------------------------------------------------------------------
  const toggleTrend = () => {
    if (!trendOpen) setTrendsWanted(true);
    setTrendOpen(!trendOpen);
  };
  const pickTrend = (picked_: Trend) => {
    setTrend({ id: picked_.id, title: picked_.title, full: picked_ });
    setTrendOpen(false);
  };

  const refreshAll = useCallback(() => {
    void connections.reload();
    void themes.reload();
    void usage.reload();
  }, [connections.reload, themes.reload, usage.reload]);

  const generate = async () => {
    if (requesting.current || platforms.length === 0) return;
    requesting.current = true;
    Keyboard.dismiss();
    setGenError(null);
    setBatch(null);
    setPhase('generating');
    try {
      const res = await api.generate({
        platforms,
        theme_id: theme?.id ?? null,
        trend_id: trendView?.id ?? null,
        brief: brief.trim() || undefined,
        tone: tone ?? undefined,
      });
      const posts = orderLike(res.posts, platforms);
      if (posts.length === 0) throw new Error('No posts came back');
      setBatch({ id: res.batch_id, aiUsed: res.ai_used, posts, themeColor: theme?.color ?? null });
      setPhase('result');
      haptic.success();
    } catch (e) {
      setGenError(errorMessage(e));
      setPhase('form');
      haptic.warn();
    } finally {
      requesting.current = false;
      void usage.reload();
    }
  };

  const backToForm = () => {
    setBatch(null);
    setPhase('form');
  };

  // ---- render ----------------------------------------------------------------------------------------------------
  const generating = phase === 'generating';
  const showResult = phase === 'result' && batch !== null;
  const canGenerate = platforms.length > 0 && !generating;
  const count = platforms.length;
  const refreshing = connections.refreshing || themes.refreshing || usage.refreshing;

  // The Generate button stays pinned above the tab bar, so it is one tap away however long the form gets.
  const generateBar = (
    <View style={styles.bar}>
      <View style={styles.barInner}>
        <Button
          title={generating ? 'Generating...' : count > 0 ? `Generate ${count} ${count === 1 ? 'post' : 'posts'}` : 'Generate posts'}
          icon="sparkles"
          full
          loading={generating}
          disabled={!canGenerate}
          onPress={() => void generate()}
        />
      </View>
    </View>
  );

  return (
    // The form and the result are separate screens: a fresh scroll view puts the result (or the form) at the top.
    <Screen
      key={showResult ? 'result' : 'form'}
      title="Create"
      subtitle="One idea, a native post for every channel"
      onRefresh={refreshAll}
      refreshing={refreshing}
      footer={showResult ? undefined : generateBar}
    >
      {showResult && batch ? (
        <ResultView
          key={batch.id}
          batch={batch}
          connections={connections.data}
          brandName={workspace?.brand_name || APP_NAME}
          onBack={backToForm}
        />
      ) : (
        <>
          <View style={[styles.stack, generating && styles.locked]}>
            <Card style={styles.sections}>
              <PlatformPicker selected={platforms} onChange={setPicked} />
              <ThemePicker
                themes={activeThemes}
                loading={themes.loading && !themes.data}
                failed={!!themes.error && !themes.data}
                selectedId={theme?.id ?? null}
                onSelect={setThemeId}
                onRetry={() => void themes.reload()}
              />
              <TrendPicker
                choice={trendView}
                open={trendOpen}
                onToggle={toggleTrend}
                list={trends.data}
                loading={trendsLoading}
                failed={trendsFailed}
                retrying={trends.fetching}
                onRetry={() => void trends.reload()}
                onPick={pickTrend}
                onClear={() => setTrend(null)}
              />
            </Card>
            <Card>
              <BriefFields brief={brief} onBrief={setBrief} tone={tone} onTone={setTone} disabled={generating} />
            </Card>
          </View>

          <View style={styles.generate}>
            <UsageLine usage={usage.data} loading={usage.loading} />
            {count === 0 ? <Text style={styles.hint}>Select at least one platform to generate.</Text> : null}
            {genError && !generating ? (
              <Card padded={false}>
                <ErrorState title="Couldn't generate" message={genError} onRetry={() => void generate()} />
              </Card>
            ) : null}
            {generating ? <GeneratingState platforms={platforms} hasTrend={!!trendView} themeName={theme?.name} /> : null}
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  // While Claude writes the form is read-only and dimmed.
  locked: { opacity: 0.55, pointerEvents: 'none' },
  sections: { gap: space.xl },
  generate: { gap: space.md },
  bar: {
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  barInner: { width: '100%', maxWidth: MAX_CONTENT_WIDTH },
  hint: { fontSize: 12.5, textAlign: 'center', color: colors.textMute },
});
