import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, Tabs } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { Platform, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfflineView, SplashView } from '@/src/components/BootStates';
import { MAX_CONTENT_WIDTH } from '@/src/config';
import { useWide } from '@/src/layout';
import { Sidebar } from '@/src/layout/Sidebar';
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

/** Wide screens (>= 1024 px): the navigator's own `tabBar` slot is filled with the left sidebar. */
const renderSidebar = (props: BottomTabBarProps) => <Sidebar {...props} />;

export default function TabsLayout() {
  const { status } = useSession();
  const insets = useSafeAreaInsets();
  const wide = useWide();
  if (status === 'loading') return <SplashView />;
  if (status === 'anon') return <Redirect href="/onboarding" />;
  if (status === 'offline') return <OfflineView />;

  return (
    <Tabs
      // Below 1024 px: the stock bottom tab bar, options untouched. At >= 1024 px: `tabBarPosition: 'left'` makes the
      // navigator lay out [bar | scenes] as a row (no bottom bar is rendered) and the custom bar is the sidebar.
      tabBar={wide ? renderSidebar : undefined}
      screenOptions={{
        ...(wide ? { tabBarPosition: 'left' as const } : null),
        headerShown: false,
        sceneStyle: { backgroundColor: colors.bg },
        tabBarActiveTintColor: '#a794ff',
        tabBarInactiveTintColor: colors.textMute,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          // Web: roomier bar (icon + label), the home-indicator inset added explicitly, capped width on desktop.
          ...(Platform.OS === 'web'
            ? {
                height: 62 + insets.bottom,
                paddingTop: 6,
                paddingBottom: 6 + insets.bottom,
                width: '100%' as const,
                maxWidth: MAX_CONTENT_WIDTH,
                alignSelf: 'center' as const,
              }
            : null),
        },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: 'Dashboard',
          tabBarButtonTestID: 'tab-dashboard',
          tabBarIcon: ({ color, size }) => <Ionicons name="stats-chart" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="trends"
        options={{
          title: 'Trends',
          tabBarButtonTestID: 'tab-trends',
          tabBarIcon: ({ color, size }) => <Ionicons name="trending-up" size={size + 2} color={color} />,
        }}
      />
      <Tabs.Screen
        name="create"
        options={{
          title: 'Create',
          tabBarButtonTestID: 'tab-create',
          tabBarIcon: ({ focused }) => <CreateIcon focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="queue"
        options={{
          title: 'Queue',
          tabBarButtonTestID: 'tab-queue',
          tabBarIcon: ({ color, size }) => <Ionicons name="albums" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarButtonTestID: 'tab-settings',
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
