import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, Tabs } from 'expo-router';
import { Platform, StyleSheet } from 'react-native';

import { OfflineView, SplashView } from '@/src/components/BootStates';
import { MAX_CONTENT_WIDTH } from '@/src/config';
import { useSession } from '@/src/session';
import { colors, gradient } from '@/src/theme';

function CreateIcon({ focused }: { focused: boolean }) {
  return (
    <LinearGradient
      colors={gradient.colors}
      start={gradient.start}
      end={gradient.end}
      style={[styles.createBubble, !focused && styles.createDim]}
    >
      <Ionicons name="sparkles" size={19} color="#ffffff" />
    </LinearGradient>
  );
}

export default function TabsLayout() {
  const { status } = useSession();
  if (status === 'loading') return <SplashView />;
  if (status === 'anon') return <Redirect href="/onboarding" />;
  if (status === 'offline') return <OfflineView />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.bg },
        tabBarActiveTintColor: '#a794ff',
        tabBarInactiveTintColor: colors.textMute,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          ...(Platform.OS === 'web'
            ? { height: 64, paddingTop: 6, paddingBottom: 8, width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center' as const }
            : null),
        },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color, size }) => <Ionicons name="stats-chart" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="trends"
        options={{
          title: 'Trends',
          tabBarIcon: ({ color, size }) => <Ionicons name="trending-up" size={size + 2} color={color} />,
        }}
      />
      <Tabs.Screen name="create" options={{ title: 'Create', tabBarIcon: ({ focused }) => <CreateIcon focused={focused} /> }} />
      <Tabs.Screen
        name="queue"
        options={{
          title: 'Queue',
          tabBarIcon: ({ color, size }) => <Ionicons name="albums" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Ionicons name="settings" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  createBubble: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  createDim: { opacity: 0.78 },
});
