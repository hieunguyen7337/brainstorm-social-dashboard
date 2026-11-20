import { Platform, StyleSheet, Switch, Text, View } from 'react-native';

import { colors, type as t } from '@/src/theme';
import { haptic } from './utils';

export function Toggle({
  value,
  onValueChange,
  disabled,
  label,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  const sw = (
    <Switch
      value={value}
      disabled={disabled}
      onValueChange={(v) => {
        haptic.select();
        onValueChange(v);
      }}
      trackColor={{ false: colors.cardHi, true: colors.accent }}
      thumbColor={Platform.OS === 'android' ? (value ? colors.white : colors.textDim) : colors.white}
      ios_backgroundColor={colors.cardHi}
      accessibilityLabel={label}
    />
  );
  if (!label) return sw;
  return (
    <View style={styles.row}>
      <Text style={[t.body, styles.label]}>{label}</Text>
      {sw}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  label: { flex: 1 },
});
