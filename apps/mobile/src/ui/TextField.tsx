import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';

import { colors, radius, type as t } from '@/src/theme';
import { webNoOutline } from './utils';

const MIN_MULTILINE = 96;
const MAX_MULTILINE = 260;

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
export function TextField({
  label,
  hint,
  error,
  right,
  style,
  inputStyle,
  multiline,
  onFocus,
  onBlur,
  onContentSizeChange,
  ...rest
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  // Multiline fields grow with their text (up to a cap, then they scroll).
  // Native: the reported content height. Web: measure the textarea's scrollHeight (it includes the element's own
  // height, so it must be reset first, otherwise the field would only ever grow).
  const [contentH, setContentH] = useState(0);
  const inputRef = useRef<TextInput>(null);
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || !multiline) return;
    const el = inputRef.current as unknown as { style?: CSSStyleDeclaration; scrollHeight?: number } | null;
    if (!el?.style || typeof el.scrollHeight !== 'number') return;
    el.style.height = 'auto';
    const h = Math.min(MAX_MULTILINE, Math.max(MIN_MULTILINE, el.scrollHeight));
    el.style.height = `${h}px`;
  }, [rest.value, multiline]);
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
          ref={inputRef}
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
          onContentSizeChange={(e) => {
            if (multiline && Platform.OS !== 'web') setContentH(Math.ceil(e.nativeEvent.contentSize.height));
            onContentSizeChange?.(e);
          }}
          style={[
            styles.input,
            multiline && styles.multiline,
            multiline && contentH > 0 ? { height: Math.min(MAX_MULTILINE, Math.max(MIN_MULTILINE, contentH + 24)) } : null,
            webNoOutline,
            inputStyle,
          ]}
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
  // 16px: smaller inputs make iOS Safari zoom the page on focus.
  input: { flex: 1, color: colors.text, fontSize: 16, paddingVertical: 12, minWidth: 0 },
  multiline: { minHeight: MIN_MULTILINE, textAlignVertical: 'top' },
  hint: { marginTop: 6 },
  error: { marginTop: 6, fontSize: 12.5, color: colors.danger },
});
