import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { publicBaseUrl } from '@/src/api';
import { AutopilotSection } from '@/src/components/settings/AutopilotSection';
import { BrandSection } from '@/src/components/settings/BrandSection';
import { ClaudeMcpCard } from '@/src/components/settings/ClaudeMcpCard';
import { ConnectorsSection, type ConnectorsHandle } from '@/src/components/settings/ConnectorsSection';
import { GetTheAppCard } from '@/src/components/settings/GetTheAppCard';
import { ThemesSection } from '@/src/components/settings/ThemesSection';
import { APP_NAME } from '@/src/config';
import { useSession } from '@/src/session';
import { colors, space, type as t, withAlpha } from '@/src/theme';
import { Button, Card, Screen, confirm } from '@/src/ui';

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

/**
 * Settings tab: brand profile, themes, connectors, autopilot, Claude (MCP), get the app, reset.
 * Every section component renders its own SectionHeader (ThemesSection and AutopilotSection included).
 */
export default function SettingsScreen() {
  const { workspace } = useSession();
  const connectors = useRef<ConnectorsHandle>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Pull to refresh (native) / the refresh button (web) reloads the connectors. Themes and Autopilot load their own
  // data and re-fetch quietly when the tab regains focus.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await connectors.current?.reload();
    } finally {
      setRefreshing(false);
    }
  }, []);

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

      <ConnectorsSection handleRef={connectors} />

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
    const ok = await confirm(
      'Reset workspace?',
      'This forgets the current workspace on this device and starts a fresh demo with new sample data. Your current posts, themes and stats will be gone.',
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
            Forget this demo workspace on this device and start a fresh one with new sample data.
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
        {mock ? 'Offline demo (mock data)' : `Connected to ${publicBaseUrl()}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { gap: space.xl },
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
