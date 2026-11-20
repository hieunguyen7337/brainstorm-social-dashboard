/**
 * Left sidebar navigation for the wide (>= 1024 px) layout. It replaces the bottom tab bar through the `tabBar`
 * prop of the `Tabs` navigator, so routing, deep links and tab state stay exactly the navigator's own.
 *
 * Items are built from the same `Tabs.Screen` options as the bottom bar (title, `tabBarIcon`, `tabBarButtonTestID`),
 * so the two bars can never drift apart: Dashboard, Trends, Create, Queue, Settings.
 */
import type { BottomTabBarProps } from 'expo-router/tabs';
import { useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { APP_NAME } from '@/src/config';
import { useSession } from '@/src/session';
import { Logo } from '@/src/ui/Logo';
import { colors, radius, space, withAlpha } from '@/src/theme';

/** Width of the sidebar in px. The wide content area is the window width minus this. */
export const SIDEBAR_WIDTH = 220;

const ICON_SIZE = 20;
/** Same violet as the bottom bar's `tabBarActiveTintColor`. */
const ACTIVE_TINT = '#a794ff';

interface ItemProps {
  label: string;
  focused: boolean;
  testID?: string;
  accessibilityLabel?: string;
  icon: ReactNode;
  onPress: () => void;
  onLongPress: () => void;
}

function SidebarItem({ label, focused, testID, accessibilityLabel, icon, onPress, onLongPress }: ItemProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="tab"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: focused }}
      aria-selected={focused}
      onPress={onPress}
      onLongPress={onLongPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        styles.item,
        focused && styles.itemActive,
        !focused && hovered && styles.itemHover,
        pressed && styles.itemPressed,
      ]}
    >
      <View style={styles.iconSlot}>{icon}</View>
      <Text
        numberOfLines={1}
        style={[styles.itemLabel, focused ? styles.itemLabelActive : hovered && styles.itemLabelHover]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Sidebar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const { workspace } = useSession();
  const brand = workspace?.brand_name?.trim() || workspace?.name?.trim() || APP_NAME;

  return (
    <View
      testID="sidebar"
      role="navigation"
      aria-label="Main"
      style={[styles.root, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg }]}
    >
      <View style={styles.brandRow}>
        <Logo size={38} />
        <View style={styles.brandText}>
          <Text style={styles.brandName} numberOfLines={1}>
            {brand}
          </Text>
          <Text style={styles.brandCaption} numberOfLines={1}>
            Guest workspace
          </Text>
        </View>
      </View>

      <View accessibilityRole="tablist" style={styles.nav}>
        {state.routes.map((route, index) => {
          const focused = index === state.index;
          const { options } = descriptors[route.key];
          const label =
            typeof options.tabBarLabel === 'string' ? options.tabBarLabel : (options.title ?? route.name);
          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) {
              navigation.dispatch({
                type: 'NAVIGATE',
                payload: { name: route.name, key: route.key, params: route.params },
                target: state.key,
              });
            }
          };
          return (
            <SidebarItem
              key={route.key}
              label={label}
              focused={focused}
              testID={options.tabBarButtonTestID}
              accessibilityLabel={options.tabBarAccessibilityLabel}
              onPress={onPress}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              icon={options.tabBarIcon?.({
                focused,
                color: focused ? ACTIVE_TINT : colors.textMute,
                size: ICON_SIZE,
              })}
            />
          );
        })}
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText} numberOfLines={1}>
          {APP_NAME}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: SIDEBAR_WIDTH,
    flexShrink: 0,
    alignSelf: 'stretch',
    paddingHorizontal: space.md,
    backgroundColor: colors.card,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.sm,
    marginBottom: space.xl,
  },
  brandText: { flex: 1, minWidth: 0 },
  brandName: { fontSize: 16, fontWeight: '800', letterSpacing: -0.3, color: colors.text },
  brandCaption: { fontSize: 12, lineHeight: 16, color: colors.textMute, marginTop: 1 },
  nav: { gap: space.xs },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 46,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: 'transparent',
    ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as object) : null),
  },
  itemActive: {
    backgroundColor: withAlpha(colors.accent, 0.16),
    borderColor: withAlpha(colors.accent, 0.38),
  },
  itemHover: { backgroundColor: colors.cardHi },
  itemPressed: { opacity: 0.85 },
  // One fixed-width slot so glyph icons and the 34 px Create bubble share a left edge and a text start.
  iconSlot: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  itemLabel: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.textDim },
  itemLabelActive: { color: colors.text },
  itemLabelHover: { color: colors.text },
  footer: { marginTop: 'auto', paddingTop: space.lg, paddingHorizontal: space.sm },
  footerText: { fontSize: 12, fontWeight: '600', letterSpacing: 0.3, color: colors.textMute },
});
