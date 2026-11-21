import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MAX_CONTENT_WIDTH } from '@/src/config';
import { desktopTitleBarInset } from '@/src/desktop';
import { BOARD_MAX_WIDTH, useWide } from '@/src/layout';
import { colors, space, type as t } from '@/src/theme';

export interface ScreenProps {
  title?: string;
  subtitle?: string;
  /** Header right slot (buttons, badges). */
  right?: ReactNode;
  children: ReactNode;
  /** Pull-to-refresh on native, a refresh button in the header on web. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Plain View instead of a ScrollView (the child must manage its own scrolling). Default false. */
  fixed?: boolean;
  /** Extra style for the centred content column (default gap is 16). */
  contentStyle?: StyleProp<ViewStyle>;
  /** Sticky area under the scroll content (e.g. an action bar). */
  footer?: ReactNode;
  /**
   * Wide layout only (>= 1024 px, default false): draw no title header at all. The screen renders its own header strip
   * (so `title`, `subtitle` and `right` are ignored); only the web refresh button stays, as a small floating button
   * at the top right. Has no effect below 1024 px, where the normal header is always shown.
   */
  bare?: boolean;
}

/**
 * Standard screen frame: safe-area top, big title, scrolling content centred in a 720px column, pull-to-refresh.
 * Every tab screen renders inside this. On wide windows (>= 1024 px, see `useWide`) the column grows to the 1440px
 * board width with 24px side gutters.
 */
export function Screen({
  title,
  subtitle,
  right,
  children,
  onRefresh,
  refreshing = false,
  fixed = false,
  contentStyle,
  footer,
  bare = false,
}: ScreenProps) {
  const wide = useWide();
  const insets = useSafeAreaInsets();
  const webRefresh = Platform.OS === 'web' && onRefresh;
  const bareWide = bare && wide;

  const refreshButton = webRefresh ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh"
      onPress={onRefresh}
      hitSlop={8}
      style={({ pressed }) => [styles.refreshBtn, bareWide && styles.refreshFloat, pressed && { opacity: 0.8 }]}
    >
      {refreshing ? (
        <ActivityIndicator size="small" color={colors.textDim} />
      ) : (
        <Ionicons name="refresh" size={bareWide ? 16 : 18} color={colors.textDim} />
      )}
    </Pressable>
  ) : null;

  const header =
    !bareWide && (title || right || webRefresh) ? (
      <View style={styles.header}>
        <View style={styles.headerText}>
          {title ? (
            <Text style={t.h1} accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          {subtitle ? <Text style={[t.dim, styles.subtitle]}>{subtitle}</Text> : null}
        </View>
        <View style={styles.headerRight}>
          {refreshButton}
          {right}
        </View>
      </View>
    ) : null;

  const body = (
    <View style={[styles.column, wide && styles.columnWide, contentStyle]}>
      {header}
      {children}
    </View>
  );
  // Bare + wide: the refresh button floats over the top right corner of the page gutter (it scrolls away with the page).
  const floatingRefresh = bareWide && refreshButton ? <View style={styles.floatSlot}>{refreshButton}</View> : null;

  return (
    <KeyboardAvoidingView
      // Pulse Desktop: content starts below the title bar strip, clear of the Windows window controls.
      style={[styles.root, { paddingTop: insets.top + desktopTitleBarInset() }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {fixed ? (
        <View style={[styles.fixed, wide && styles.fixedWide]}>
          {body}
          {floatingRefresh}
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, wide && styles.scrollContentWide]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={
            onRefresh && Platform.OS !== 'web' ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={colors.accent}
                colors={[colors.accent]}
                progressBackgroundColor={colors.card}
              />
            ) : undefined
          }
        >
          {body}
          {floatingRefresh}
        </ScrollView>
      )}
      {footer}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  scrollContent: { alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: 40 },
  fixed: { flex: 1, alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.lg },
  column: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, gap: space.lg },
  // Wide (>= 1024 px): the board width; `minWidth: 0` so wide children can never push the page into horizontal scroll.
  scrollContentWide: { paddingHorizontal: space.xl, paddingTop: space.xl, paddingBottom: 40 },
  fixedWide: { paddingHorizontal: space.xl, paddingTop: space.xl },
  columnWide: { maxWidth: BOARD_MAX_WIDTH, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md },
  headerText: { flex: 1, minWidth: 0 },
  subtitle: { marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  refreshBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatSlot: { position: 'absolute', top: space.sm, right: space.sm },
  refreshFloat: { width: 30, height: 30, borderRadius: 15 },
});
