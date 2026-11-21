import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';

import { api } from '@/src/api';
import { BriefFields } from '@/src/components/create/BriefFields';
import { CreateBoard } from '@/src/components/create/CreateBoard';
import { errorMessage } from '@/src/components/create/errors';
import { GeneratingState } from '@/src/components/create/GeneratingState';
import { TREND_FETCH, firstParam, orderLike, type Batch, type TrendChoice } from '@/src/components/create/logic';
import { PlatformPicker } from '@/src/components/create/PlatformPicker';
import { ResultPane } from '@/src/components/create/ResultPane';
import { ResultView } from '@/src/components/create/ResultView';
import { ThemePicker } from '@/src/components/create/ThemePicker';
import { TrendPicker } from '@/src/components/create/TrendPicker';
import { UsageLine } from '@/src/components/create/UsageLine';
import { StyleBadge } from '@/src/components/settings/StyleBadge';
import { APP_NAME, MAX_CONTENT_WIDTH } from '@/src/config';
import { useAsync } from '@/src/hooks';
import { useWide } from '@/src/layout';
import { useSession } from '@/src/session';
import { colors, space } from '@/src/theme';
import { PLATFORMS, type Platform, type Trend } from '@/src/types';
import { Button, Card, ErrorState, Screen, confirm, haptic } from '@/src/ui';

type Phase = 'form' | 'generating' | 'result';

/**
 * Generate: pick platforms, a theme, optionally a trend and a brief, press Generate and get one platform-native post
 * per platform. All state lives here, so the form survives switching tabs and the result survives too.
 */
export default function CreateScreen() {
  const wide = useWide();
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
  /** null until the user touches the chips: then the default (connected platforms) keeps following the connections. */
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
  /** Wide board only: the result on screen has edits that were never saved (set by `ResultGrid`). */
  const unsavedRef = useRef(false);

  // ---- derived ---------------------------------------------------------------------------------------------------
  const connected = useMemo(
    () => (connections.data ?? []).filter((c) => c.status === 'connected').map((c) => c.platform),
    [connections.data],
  );
  const platforms = useMemo<Platform[]>(
    () => picked ?? (connected.length > 0 ? PLATFORMS.filter((p) => connected.includes(p)) : [...PLATFORMS]),
    [picked, connected],
  );

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

  const generateButton = (onPress: () => void) => (
    <Button
      title={generating ? 'Generating...' : count > 0 ? `Generate ${count} ${count === 1 ? 'post' : 'posts'}` : 'Generate posts'}
      icon="sparkles"
      full
      loading={generating}
      disabled={!canGenerate}
      onPress={onPress}
    />
  );

  // The same form pieces serve the phone's stacked cards and the wide board's single form card.
  const platformPicker = <PlatformPicker selected={platforms} onChange={setPicked} />;
  const themePicker = (
    <ThemePicker
      themes={activeThemes}
      loading={themes.loading && !themes.data}
      failed={!!themes.error && !themes.data}
      selectedId={theme?.id ?? null}
      onSelect={setThemeId}
      onRetry={() => void themes.reload()}
    />
  );
  const trendPicker = (
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
  );
  const briefFields = <BriefFields brief={brief} onBrief={setBrief} tone={tone} onTone={setTone} disabled={generating} />;
  const usageLine = (
    <>
      <StyleBadge />
      <UsageLine usage={usage.data} loading={usage.loading} />
    </>
  );
  const noPlatformHint = count === 0 ? <Text style={styles.hint}>Select at least one platform to generate.</Text> : null;
  const errorCard =
    genError && !generating ? (
      <Card padded={false}>
        <ErrorState title="Couldn't generate" message={genError} onRetry={() => void generate()} />
      </Card>
    ) : null;

  // ---- wide (>= 1024 px): the form on the left, the generated cards in a grid on the right ---------------------------
  if (wide) {
    // The form stays on screen next to the result, so a new generation can replace posts with unsaved edits: ask first.
    const generateFromBoard = async () => {
      if (showResult && unsavedRef.current) {
        const ok = await confirm(
          'Replace these posts?',
          'Some edits have not been saved. The drafts themselves are already in your queue.',
          'Generate',
          true,
        );
        if (!ok) return;
      }
      await generate();
    };

    return (
      <Screen
        key="board"
        title="Create"
        subtitle="One idea, six platform-native posts"
        onRefresh={refreshAll}
        refreshing={refreshing}
      >
        <CreateBoard
          form={
            <Card style={styles.formCard}>
              <View style={[styles.sections, generating && styles.locked]}>
                {briefFields}
                {themePicker}
                {trendPicker}
                {platformPicker}
              </View>
              <View style={styles.generate}>
                {usageLine}
                {noPlatformHint}
                {generateButton(() => void generateFromBoard())}
                {errorCard}
              </View>
            </Card>
          }
          result={
            <ResultPane
              batch={showResult ? batch : null}
              generating={generating}
              platforms={platforms}
              hasTrend={!!trendView}
              themeName={theme?.name}
              connections={connections.data}
              brandName={workspace?.brand_name || APP_NAME}
              onBack={backToForm}
              unsavedRef={unsavedRef}
            />
          }
        />
      </Screen>
    );
  }

  // The Generate button stays pinned above the tab bar, so it is one tap away however long the form gets.
  const generateBar = (
    <View style={styles.bar}>
      <View style={styles.barInner}>{generateButton(() => void generate())}</View>
    </View>
  );

  return (
    // The form and the result are separate screens: a fresh scroll view puts the result (or the form) at the top.
    <Screen
      key={showResult ? 'result' : 'form'}
      title="Create"
      subtitle="One idea, six platform-native posts"
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
              {platformPicker}
              {themePicker}
              {trendPicker}
            </Card>
            <Card>{briefFields}</Card>
          </View>

          <View style={styles.generate}>
            {usageLine}
            {noPlatformHint}
            {errorCard}
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
  // Wide board: the one form card (fields, then usage + Generate).
  formCard: { gap: space.xl },
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
