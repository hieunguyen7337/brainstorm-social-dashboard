import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps, ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type as t, withAlpha } from '@/src/theme';
import { Button } from './Button';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** Nothing here yet. Always say what to do next. */
export function EmptyState({
  icon = 'sparkles-outline',
  title,
  message,
  action,
}: {
  icon?: IconName;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.wrap}>
      <View style={[styles.iconWrap, { backgroundColor: withAlpha(colors.accent, 0.14) }]}>
        <Ionicons name={icon} size={26} color={colors.accent} />
      </View>
      <Text style={[t.h3, styles.center]}>{title}</Text>
      {message ? <Text style={[t.dim, styles.center]}>{message}</Text> : null}
      {action}
    </View>
  );
}

/** A request failed. Offer a retry. */
export function ErrorState({
  message = 'Something went wrong.',
  onRetry,
  title = "Couldn't load this",
}: {
  message?: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <View style={styles.wrap}>
      <View style={[styles.iconWrap, { backgroundColor: withAlpha(colors.danger, 0.14) }]}>
        <Ionicons name="cloud-offline-outline" size={26} color={colors.danger} />
      </View>
      <Text style={[t.h3, styles.center]}>{title}</Text>
      <Text style={[t.dim, styles.center]}>{message}</Text>
      {onRetry ? <Button title="Try again" icon="refresh" variant="secondary" small onPress={onRetry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xxl,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
  },
  iconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  center: { textAlign: 'center' },
});
