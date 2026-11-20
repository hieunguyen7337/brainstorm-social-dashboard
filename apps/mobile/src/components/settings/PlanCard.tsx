import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { api, ApiError, isMock } from '@/src/api';
import { APP_NAME } from '@/src/config';
import { colors, gradient, radius, space, type as t, withAlpha } from '@/src/theme';
import { Badge, Button, Card, Skeleton, SkeletonCard, haptic, useToast } from '@/src/ui';
import { useCheckoutReturn, useReloadOnWindowFocus } from './plan-effects';
import { checkoutRequest, closeTab, openPlaceholderTab, openUrl } from './plan-open';
import { FeatureList, ModeNote, PriceFigure, modeNote } from './plan-parts';
import { useBilling } from './plan-state';

const WASH = [withAlpha(colors.accent, 0.18), withAlpha(colors.accent2, 0.04)] as const;

type Busy = 'upgrade' | 'portal';

const messageOf = (e: unknown): string => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
/** The server's messages are lower-case fragments ("customer portal is not available in demo mode"). */
const sentence = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * "<App> Pro" on Settings: the one upgrade card (gradient border like the Claude card). Free workspaces see what Pro
 * unlocks and an Upgrade button; Pro workspaces see what is unlocked and a Manage billing button. Renders nothing
 * at all when the server has no billing API.
 */
export function PlanCard() {
  const { show } = useToast();
  const { billing, loading, error, refreshing, reload } = useBilling();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);
  const lock = useRef(false);

  useCheckoutReturn(reload);
  useReloadOnWindowFocus(reload);

  if (billing === null) return null;
  if (billing === undefined) {
    return loading ? (
      <SkeletonCard lines={5} />
    ) : (
      <PlanLoadError message={error?.message} busy={refreshing} onRetry={() => void reload()} />
    );
  }

  const pro = billing.plan === 'pro';
  const features = Array.isArray(billing.features?.pro) ? billing.features.pro : [];
  const note = modeNote(billing.mode, pro);

  /** One action at a time, even for a double tap that lands before the next render. */
  const guarded = async (kind: Busy, work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    try {
      await work();
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const upgrade = () =>
    guarded('upgrade', async () => {
      setPortalError(null);
      // The web tab has to open inside this tap; the offline demo upgrades on the spot and has nothing to open.
      const tab = isMock() ? null : openPlaceholderTab();
      try {
        const { url } = await api.createCheckout(checkoutRequest());
        if (url) {
          show('Opening checkout...', 'info');
          if (!(await openUrl(url, tab))) show("Couldn't open the checkout page.", 'error');
        } else {
          closeTab(tab);
          haptic.success();
          show('Upgraded to Pro');
        }
      } catch (e) {
        closeTab(tab);
        show(messageOf(e), 'error');
      }
      await reload();
    });

  const manage = () =>
    guarded('portal', async () => {
      setPortalError(null);
      // Demo mode has no portal (the server answers 404), so there is no point opening a tab for it.
      const tab = isMock() || billing.mode === 'demo' ? null : openPlaceholderTab();
      try {
        const { url } = await api.createPortal();
        if (!(await openUrl(url, tab))) setPortalError("Couldn't open the billing portal.");
      } catch (e) {
        closeTab(tab);
        setPortalError(sentence(messageOf(e)));
      }
    });

  return (
    <LinearGradient
      colors={gradient.colors}
      start={gradient.start}
      end={gradient.end}
      style={styles.border}
      testID="plan-card"
    >
      <View style={styles.inner}>
        <LinearGradient colors={WASH} start={gradient.start} end={gradient.end} style={StyleSheet.absoluteFill} />

        <View style={styles.head}>
          <LinearGradient colors={gradient.colors} start={gradient.start} end={gradient.end} style={styles.chip}>
            <Ionicons name="flash" size={20} color={colors.white} />
          </LinearGradient>
          <View style={styles.headText}>
            <Text style={t.h2} numberOfLines={1} accessibilityRole="header">
              {`${APP_NAME} Pro`}
            </Text>
            <Text style={t.dim}>MCP + autopilot</Text>
          </View>
          {pro ? <Badge label="PRO PLAN" tone="accent" icon="checkmark-circle" /> : <Badge label="FREE PLAN" />}
        </View>

        {billing.price_label ? <PriceFigure label={billing.price_label} /> : null}

        {pro ? (
          <View style={styles.proPanel}>
            <View style={styles.proHead}>
              <Ionicons name="checkmark-circle" size={20} color={colors.success} aria-hidden />
              <Text style={styles.proTitle}>You&apos;re on Pro</Text>
            </View>
            {features.length > 0 ? <Text style={t.label}>Unlocked</Text> : null}
            <FeatureList items={features} tint={colors.success} />
          </View>
        ) : (
          <FeatureList items={features} tint={colors.accent} />
        )}

        <View style={styles.cta}>
          {pro ? (
            <Button
              title="Manage billing"
              icon="card-outline"
              variant="ghost"
              full
              loading={busy === 'portal'}
              onPress={() => void manage()}
              testID="plan-manage"
            />
          ) : (
            <Button
              title="Upgrade"
              icon="flash"
              full
              loading={busy === 'upgrade'}
              onPress={() => void upgrade()}
              testID="plan-upgrade"
            />
          )}
          {portalError ? (
            <Text style={[t.small, styles.portalError]} accessibilityRole="alert">
              {portalError}
            </Text>
          ) : null}
          {note ? <ModeNote text={note} /> : null}
        </View>
      </View>
    </LinearGradient>
  );
}

/** A quiet row, not a full error screen: billing is an optional extra on Settings. */
function PlanLoadError({ message, busy, onRetry }: { message?: string; busy: boolean; onRetry: () => void }) {
  return (
    <Card style={styles.errorCard}>
      <Ionicons name="cloud-offline-outline" size={22} color={colors.textMute} aria-hidden />
      <View style={styles.errorText}>
        <Text style={t.dim}>Couldn&apos;t load your plan.</Text>
        {message ? (
          <Text style={[t.small, styles.mute]} numberOfLines={2}>
            {message}
          </Text>
        ) : null}
      </View>
      <Button title="Retry" icon="refresh" variant="secondary" small loading={busy} onPress={onRetry} />
    </Card>
  );
}

/** Tiny FREE / PRO pill for the Settings header. Follows the same shared state as the card. */
export function PlanBadge() {
  const { billing, loading } = useBilling();
  if (billing === undefined) {
    // Hold the pill's place while loading, so the header does not shift when it arrives.
    return loading ? <Skeleton width={52} height={22} rounded={11} /> : null;
  }
  if (billing === null) return null;
  const pro = billing.plan === 'pro';
  return (
    <View accessible accessibilityLabel={`Current plan: ${pro ? 'Pro' : 'Free'}`} testID="plan-badge">
      {pro ? <Badge label="PRO" tone="accent" /> : <Badge label="FREE" />}
    </View>
  );
}

const styles = StyleSheet.create({
  border: { borderRadius: radius.md, padding: 1.5 },
  inner: {
    borderRadius: radius.md - 1.5,
    backgroundColor: colors.card,
    padding: space.lg,
    gap: space.lg,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  chip: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  proPanel: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: withAlpha(colors.success, 0.35),
    backgroundColor: withAlpha(colors.success, 0.08),
  },
  proHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  proTitle: { ...t.h3, color: colors.success },
  cta: { gap: space.sm },
  portalError: { color: colors.warn },
  errorCard: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  errorText: { flex: 1, minWidth: 0, gap: 2 },
  mute: { color: colors.textMute },
});
