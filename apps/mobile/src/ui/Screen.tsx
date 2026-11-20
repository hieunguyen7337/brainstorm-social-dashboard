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
import { useSession } from '@/src/session';
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
}

/**
 * Standard screen frame: safe-area top, big title, scrolling content centred in a 720px column, pull-to-refresh.
 * Every tab screen renders inside this.
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
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const { workspace } = useSession();
  const webRefresh = Platform.OS === 'web' && onRefresh;

  const header =
    title || right || webRefresh ? (
      <View style={styles.header}>
        <View style={styles.headerText}>
          {title && workspace?.name ? (
            <Text style={styles.workspace} numberOfLines={1} testID="workspace-name">
              {workspace.name}
            </Text>
          ) : null}
          {title ? (
            <Text style={t.h1} accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          {subtitle ? <Text style={[t.dim, styles.subtitle]}>{subtitle}</Text> : null}
        </View>
        <View style={styles.headerRight}>
          {webRefresh ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh"
              onPress={onRefresh}
              hitSlop={8}
              style={({ pressed }) => [styles.refreshBtn, pressed && { opacity: 0.8 }]}
            >
              {refreshing ? (
                <ActivityIndicator size="small" color={colors.textDim} />
              ) : (
                <Ionicons name="refresh" size={18} color={colors.textDim} />
              )}
            </Pressable>
          ) : null}
          {right}
        </View>
      </View>
    ) : null;

  const body = (
    <View style={[styles.column, contentStyle]}>
      {header}
      {children}
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {fixed ? (
        <View style={styles.fixed}>{body}</View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
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
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md },
  headerText: { flex: 1, minWidth: 0 },
  subtitle: { marginTop: 2 },
  workspace: { ...t.label, color: colors.textMute, marginBottom: 2 },
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
});
