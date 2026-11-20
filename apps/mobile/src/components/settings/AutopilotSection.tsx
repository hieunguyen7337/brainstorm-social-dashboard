/**
 * Settings > Autopilot: the background loop that picks a trend and a theme, drafts posts and queues or publishes
 * them. Every change saves by itself (optimistic, coalesced, reverted with a toast on failure): no save button.
 * Logic lives in `autopilot-logic.tsx`, the data hook in `autopilot-state.tsx`, small views in `autopilot-parts.tsx`.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';

import { api } from '@/src/api';
import { useAsync } from '@/src/hooks';
import { colors, platformMeta, space, type as t, withAlpha } from '@/src/theme';
import { PLATFORMS, type AutopilotRun, type Platform as PlatformId, type Theme, type Trend } from '@/src/types';
import {
  Button,
  Card,
  Chip,
  ChipRow,
  ErrorState,
  SectionHeader,
  TextField,
  Toggle,
  haptic,
  useToast,
} from '@/src/ui';
import {
  INTERVAL_PRESETS,
  MAX_INTERVAL,
  MIN_INTERVAL,
  clampInterval,
  defaultPlatforms,
  lastRunLine,
  statusLine,
  togglePlatform,
} from './autopilot-logic';
import {
  AutopilotSkeleton,
  PulseDot,
  RunResultCard,
  SavedBadge,
  queueTabFor,
  type RunNames,
  type RunView,
} from './autopilot-parts';
import { messageOf, useAutopilotConfig, useNow } from './autopilot-state';

const CONNECTIONS_POLL_MS = 10_000;
const NOW_TICK_MS = 20_000;
/** The platform Switch is small; scale it up for the hero row (web's is smaller still). */
const HERO_SWITCH_SCALE = Platform.OS === 'web' ? 1.35 : 1.15;

/** Best-effort: turn the run's trend and theme ids into names. Never throws; missing names fall back in the card. */
async function lookUpNames(run: AutopilotRun): Promise<RunNames> {
  const none: RunNames = { trendTitle: null, themeName: null, themeColor: null };
  try {
    const [trends, themes] = await Promise.allSettled([
      run.trend_id ? api.listTrends({ limit: 50 }) : Promise.resolve<Trend[]>([]),
      run.theme_id ? api.listThemes() : Promise.resolve<Theme[]>([]),
    ]);
    const trend =
      trends.status === 'fulfilled' && Array.isArray(trends.value)
        ? trends.value.find((x) => x.id === run.trend_id)
        : undefined;
    const theme =
      themes.status === 'fulfilled' && Array.isArray(themes.value)
        ? themes.value.find((x) => x.id === run.theme_id)
        : undefined;
    return { trendTitle: trend?.title ?? null, themeName: theme?.name ?? null, themeColor: theme?.color ?? null };
  } catch {
    return none;
  }
}

export function AutopilotSection() {
  const { show } = useToast();
  const { cfg, error, loading, refreshing, reload, edit, runCycle, savedAt } = useAutopilotConfig();
  const conns = useAsync(() => api.listConnections(), [], { intervalMs: CONNECTIONS_POLL_MS });
  const reloadConnections = conns.reload;
  const now = useNow(NOW_TICK_MS);

  /** Text of the custom-interval field while it is being edited; null = show the saved interval. */
  const [customText, setCustomText] = useState<string | null>(null);
  const [platformHint, setPlatformHint] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunView | null>(null);
  const alive = useRef(true);
  const runningRef = useRef(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, []);

  useEffect(() => {
    if (savedAt) AccessibilityInfo.announceForAccessibility('Autopilot settings saved');
  }, [savedAt]);

  /** Which platforms are connected; null until the list is known (then nothing is dimmed). */
  const connected = useMemo(() => {
    if (!conns.data) return null;
    return new Set(conns.data.filter((c) => c.status === 'connected').map((c) => c.platform));
  }, [conns.data]);

  const requireApproval = cfg?.require_approval ?? true;

  const runNow = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setResult(null);
    try {
      const run = await runCycle();
      if (!alive.current) return;
      haptic.success();
      setResult({ run, names: null, requireApproval });
      void lookUpNames(run).then((names) => {
        if (alive.current) setResult((cur) => (cur && cur.run === run ? { ...cur, names } : cur));
      });
    } catch (e) {
      show(messageOf(e), 'error');
    } finally {
      runningRef.current = false;
      if (alive.current) setRunning(false);
    }
  }, [runCycle, requireApproval, show]);

  const openQueue = useCallback(() => {
    if (!result) return;
    router.push({ pathname: '/queue', params: { tab: queueTabFor(result) } });
  }, [result]);

  const retry = useCallback(() => {
    void reload();
    void reloadConnections();
  }, [reload, reloadConnections]);

  if (!cfg) {
    return (
      <View style={styles.section}>
        <Header />
        {loading || refreshing ? (
          <AutopilotSkeleton />
        ) : (
          <Card>
            <ErrorState message={error?.message ?? 'Something went wrong.'} onRetry={retry} />
          </Card>
        )}
      </View>
    );
  }

  const enabled = cfg.enabled;
  const interval = cfg.interval_min;
  const selected = new Set(cfg.platforms);
  const hasDisconnected = connected !== null && PLATFORMS.some((p) => !connected.has(p));

  const setEnabled = (next: boolean) => {
    // Never leave autopilot on with nothing to post to: fill the platforms in the same save.
    if (next && cfg.platforms.length === 0) edit({ enabled: true, platforms: defaultPlatforms(conns.data) }, 'now');
    else edit({ enabled: next }, 'now');
  };

  const pickInterval = (minutes: number) => {
    setCustomText(null);
    edit({ interval_min: minutes }, 'now');
  };

  const typeInterval = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 4);
    setCustomText(digits);
    const n = parseInt(digits, 10);
    if (Number.isFinite(n) && n >= MIN_INTERVAL) edit({ interval_min: clampInterval(n) }, 'debounced');
  };

  const finishInterval = () => {
    if (customText === null) return;
    const n = parseInt(customText, 10);
    setCustomText(null);
    if (!Number.isFinite(n)) return;
    const minutes = clampInterval(n);
    if (minutes !== interval) edit({ interval_min: minutes }, 'now');
  };

  const flashPlatformHint = () => {
    haptic.warn();
    setPlatformHint(true);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => {
      hintTimer.current = null;
      setPlatformHint(false);
    }, 2600);
  };

  const pickPlatform = (platform: PlatformId) => {
    const next = togglePlatform(cfg.platforms, platform);
    if (!next) {
      flashPlatformHint(); // the tap would clear the last platform: ignore it
      return;
    }
    setPlatformHint(false);
    edit({ platforms: next }, 'now');
  };

  const customOut = customText !== null && customText !== '' && (Number(customText) < MIN_INTERVAL || Number(customText) > MAX_INTERVAL);
  const customHint = customOut
    ? `Will be set to ${clampInterval(Number(customText))} minutes`
    : `${MIN_INTERVAL} to ${MAX_INTERVAL} minutes`;

  return (
    <View style={styles.section}>
      <Header />

      <Card style={enabled ? styles.heroOn : undefined}>
        <View style={styles.hero}>
          <PulseDot on={enabled} />
          <View style={styles.heroText}>
            <Text style={t.h3}>Autopilot</Text>
            <Text style={[t.dim, enabled && styles.statusOn]} numberOfLines={2}>
              {statusLine(cfg, now)}
            </Text>
          </View>
          <View style={styles.heroSwitch}>
            <Toggle value={enabled} onValueChange={setEnabled} />
          </View>
        </View>
      </Card>

      <Card>
        <Text style={t.label}>Run every</Text>
        <ChipRow style={styles.chips}>
          {INTERVAL_PRESETS.map((p) => (
            <Chip key={p.minutes} label={p.label} selected={interval === p.minutes} onPress={() => pickInterval(p.minutes)} />
          ))}
        </ChipRow>
        <TextField
          label="Custom (minutes)"
          value={customText ?? String(interval)}
          onChangeText={typeInterval}
          onFocus={() => setCustomText(String(interval))}
          onBlur={finishInterval}
          onSubmitEditing={finishInterval}
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={4}
          selectTextOnFocus
          hint={customHint}
          style={styles.customField}
        />
      </Card>

      <Card>
        <Text style={t.label}>Post to</Text>
        <ChipRow style={styles.chips}>
          {PLATFORMS.map((p) => (
            <Chip
              key={p}
              platform={p}
              label={platformMeta[p].label}
              selected={selected.has(p)}
              onPress={() => pickPlatform(p)}
              style={connected && !connected.has(p) ? styles.dimmed : undefined}
            />
          ))}
        </ChipRow>
        {platformHint ? (
          <Text style={[t.small, styles.note, { color: colors.warn }]} accessibilityLiveRegion="polite">
            Keep at least one platform selected.
          </Text>
        ) : hasDisconnected ? (
          <Text style={[t.small, styles.note]}>Faded platforms are not connected yet. You can still select them.</Text>
        ) : null}
      </Card>

      <Card>
        <Toggle
          label="Ask me before publishing"
          value={cfg.require_approval}
          onValueChange={(v) => edit({ require_approval: v }, 'now')}
        />
        <View style={styles.explain}>
          <Ionicons
            name={cfg.require_approval ? 'shield-checkmark-outline' : 'flash-outline'}
            size={16}
            color={cfg.require_approval ? colors.success : colors.warn}
          />
          <Text style={[t.small, styles.explainText]}>
            {cfg.require_approval
              ? 'On: autopilot drafts land in your Queue for approval. Nothing goes out until you say so.'
              : 'Off: posts are published automatically (sandbox, so nothing leaves the app).'}
          </Text>
        </View>
      </Card>

      <Card>
        <Button title="Run one cycle now" icon="flash" loading={running} onPress={runNow} full />
        <Text style={[t.small, styles.runNote]}>
          {running ? 'Picking a trend and drafting posts. This can take a few seconds...' : lastRunLine(cfg.last_run_at, now)}
        </Text>
      </Card>

      {result ? <RunResultCard view={result} onOpenQueue={openQueue} onDismiss={() => setResult(null)} /> : null}

      <View pointerEvents="none" style={styles.savedSlot}>
        <SavedBadge stamp={savedAt} />
      </View>
    </View>
  );
}

function Header() {
  return (
    <SectionHeader
      title="Autopilot"
      subtitle="Claude picks a trend and a theme, drafts posts, and queues or publishes them for you"
    />
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  savedSlot: { position: 'absolute', top: 2, right: 0 },
  heroOn: { backgroundColor: withAlpha(colors.accent, 0.1), borderColor: withAlpha(colors.accent, 0.55) },
  hero: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  heroText: { flex: 1, minWidth: 0, gap: 2 },
  statusOn: { color: colors.success },
  heroSwitch: { transform: [{ scale: HERO_SWITCH_SCALE }], marginRight: 6 },
  chips: { marginTop: space.md },
  customField: { marginTop: space.lg, width: 176 },
  dimmed: { opacity: 0.5 },
  note: { marginTop: space.md },
  explain: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginTop: space.md },
  explainText: { flex: 1 },
  runNote: { textAlign: 'center', marginTop: space.md },
});
