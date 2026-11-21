import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { publicBaseUrl } from '@/src/api';
import { AccountsSection } from '@/src/components/settings/AccountsSection';
import { AutopilotSection } from '@/src/components/settings/AutopilotSection';
import { BrandSection } from '@/src/components/settings/BrandSection';
import { ClaudeMcpCard } from '@/src/components/settings/ClaudeMcpCard';
import { ConnectorsSection, type ConnectorsHandle } from '@/src/components/settings/ConnectorsSection';
import { GetTheAppCard } from '@/src/components/settings/GetTheAppCard';
import { ThemesSection } from '@/src/components/settings/ThemesSection';
import { VaultSection } from '@/src/components/settings/VaultSection';
import { APP_NAME } from '@/src/config';
import { BOARD_MAX_WIDTH, Col, Grid, useWide } from '@/src/layout';
import { useIsRealWorkspace, useSession } from '@/src/session';
import { colors, space, type as t, withAlpha } from '@/src/theme';
import { Button, Card, Screen, confirm } from '@/src/ui';

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

/**
 * Settings tab: brand profile, themes, accounts (connectors in an old sample workspace), autopilot, Claude (MCP), get
 * the app, reset. Every section component renders its own SectionHeader (ThemesSection and AutopilotSection included).
 */
export default function SettingsScreen() {
  const wide = useWide();
  const { workspace } = useSession();
  const real = useIsRealWorkspace();
  // `ConnectAccountsHandle` has the same shape, so one ref serves both sections.
  const connectors = useRef<ConnectorsHandle>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Pull to refresh (native) / the refresh button (web) reloads the accounts (or the connectors). Themes and Autopilot
  // load their own data and re-fetch quietly when the tab regains focus.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await connectors.current?.reload();
    } finally {
      setRefreshing(false);
    }
  }, []);

  // A real workspace connects accounts by screenshot or typed numbers; an old sample one keeps the sandbox connectors.
  const accounts = real ? <AccountsSection handleRef={connectors} /> : <ConnectorsSection handleRef={connectors} />;

  // >= 1024 px: two independent stacked columns of the same sections (heights balanced by hand), footer underneath.
  // The narrow branch below is the original phone tree, untouched.
  if (wide) {
    return (
      <Screen
        title="Settings"
        subtitle={workspace ? `${workspace.brand_name} · guest workspace` : undefined}
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        contentStyle={styles.wideColumn}
      >
        <Grid gap={space.xl} testID="settings-board">
          <Col span={6} style={styles.wideStack} testID="settings-col-left">
            <BrandSection />
            <ThemesSection />
            <AutopilotSection />
            <ResetCard />
          </Col>
          <Col span={6} style={styles.wideStack} testID="settings-col-right">
            {accounts}
            {real ? <VaultSection /> : null}
            <ClaudeMcpCard />
            <GetTheAppCard />
          </Col>
        </Grid>
        <Footer />
      </Screen>
    );
  }

  return (
    <Screen
      title="Settings"
      subtitle={workspace ? `${workspace.brand_name} · guest workspace` : undefined}
      onRefresh={() => void refresh()}
      refreshing={refreshing}
      contentStyle={styles.column}
    >
      <BrandSection />

      <ThemesSection />

      {accounts}
      {real ? <VaultSection /> : null}

      <AutopilotSection />

      <ClaudeMcpCard />
      <GetTheAppCard />
      <ResetCard />
      <Footer />
    </Screen>
  );
}

function ResetCard() {
  const { signOut } = useSession();
  const [busy, setBusy] = useState(false);

  const reset = async () => {
    if (busy) return;
    // A reset always ends in a new, empty real workspace (onboarding), whatever this workspace was.
    const ok = await confirm(
      'Reset workspace?',
      'This forgets the current workspace on this device and starts a new, empty one. Your connected numbers, posts, themes and saved logins will be gone.',
      'Reset',
      true,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await signOut();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={styles.danger}>
      <View style={styles.dangerHead}>
        <View style={styles.dangerIcon}>
          <Ionicons name="refresh-circle-outline" size={26} color={colors.danger} />
        </View>
        <View style={styles.dangerText}>
          <Text style={[t.h3, styles.dangerTitle]}>Reset workspace</Text>
          <Text style={t.dim}>
            Forget this workspace on this device and start a new, empty one. Your connected numbers, posts, themes and saved
            logins will be gone.
          </Text>
        </View>
      </View>
      <Button title="Reset workspace" variant="danger" loading={busy} onPress={() => void reset()} full />
    </Card>
  );
}

function Footer() {
  const { mock } = useSession();
  return (
    <View style={styles.footer}>
      <Text style={styles.footerText}>{`${APP_NAME} · version ${APP_VERSION}`}</Text>
      <Text style={styles.footerText} selectable>
        {mock ? 'Test build (mock data)' : `Connected to ${publicBaseUrl()}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { gap: space.xl },
  wideColumn: { gap: space.xl, maxWidth: BOARD_MAX_WIDTH },
  wideStack: { gap: space.xl },
  danger: {
    gap: space.lg,
    borderColor: withAlpha(colors.danger, 0.4),
    backgroundColor: withAlpha(colors.danger, 0.06),
  },
  dangerHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  dangerIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(colors.danger, 0.14),
  },
  dangerText: { flex: 1, minWidth: 0, gap: 2 },
  dangerTitle: { color: colors.danger },
  footer: { alignItems: 'center', gap: 2, paddingBottom: space.sm },
  footerText: { fontSize: 12.5, lineHeight: 18, textAlign: 'center', color: colors.textMute },
});
