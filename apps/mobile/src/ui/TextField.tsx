import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';

import { colors, radius, type as t } from '@/src/theme';
import { webNoOutline } from './utils';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  hint?: string;
  error?: string | null;
  /** Node rendered inside the field on the right (e.g. a counter or an icon button). */
  right?: ReactNode;
  style?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
}

/** Labelled dark text input with a violet focus ring. */
export function TextField({ label, hint, error, right, style, inputStyle, multiline, onFocus, onBlur, ...rest }: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={style}>
      {label ? <Text style={[t.label, styles.label]}>{label}</Text> : null}
      <View
        style={[
          styles.box,
          focused && styles.focused,
          !!error && styles.errorBox,
          multiline && styles.multilineBox,
        ]}
      >
        <TextInput
          {...rest}
          multiline={multiline}
          placeholderTextColor={colors.textMute}
          selectionColor={colors.accent}
          accessibilityLabel={rest.accessibilityLabel ?? label}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, multiline && styles.multiline, webNoOutline, inputStyle]}
        />
        {right}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={[t.small, styles.hint]}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { marginBottom: 6 },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardHi,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    minHeight: 48,
  },
  multilineBox: { alignItems: 'flex-start', paddingVertical: 2 },
  focused: { borderColor: colors.accent },
  errorBox: { borderColor: colors.danger },
  input: { flex: 1, color: colors.text, fontSize: 15.5, paddingVertical: 12, minWidth: 0 },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
  hint: { marginTop: 6 },
  error: { marginTop: 6, fontSize: 12.5, color: colors.danger },
});
