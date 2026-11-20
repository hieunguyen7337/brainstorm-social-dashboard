/**
 * Editable text for the preview cards. Every card renders its copy through `PreviewText`: read-only it is a selectable
 * `Text`, editable it becomes an in-place multiline `TextInput` with the very same typography.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { hashtagsText, parseHashtags } from '@/src/format';
import { withAlpha } from '@/src/theme';

/** Web-only CSS that React Native's `TextStyle` has no key for, applied through a typed cast. */
function webCss(css: Record<string, string | number>): TextStyle {
  return Platform.OS === 'web' ? (css as unknown as TextStyle) : {};
}

/** No focus outline on web inputs (the card draws its own focus tint). */
export const noOutline: TextStyle = webCss({ outlineStyle: 'none', outlineWidth: 0 });

/** iOS Safari zooms the page when a focused field's font is under 16px (iPadOS reports itself as a Mac). */
function needsZoomGuard(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Flatten a text style; on iOS web raise sub-16px fonts to 16px (keeping the line-height ratio). */
export function fieldFont(style: StyleProp<TextStyle>): TextStyle {
  const flat: TextStyle = StyleSheet.flatten(style) ?? {};
  if (!needsZoomGuard()) return flat;
  const size = typeof flat.fontSize === 'number' ? flat.fontSize : 14;
  if (size >= 16) return flat;
  const lh = typeof flat.lineHeight === 'number' ? flat.lineHeight : size * 1.35;
  return { ...flat, fontSize: 16, lineHeight: Math.round((lh / size) * 16) };
}

const IDLE_TINT = 'rgba(255, 255, 255, 0.035)';

export interface AutoGrowInputProps {
  value: string;
  onChangeText?: (text: string) => void;
  placeholder: string;
  placeholderColor: string;
  /** The same text style the read-only `Text` uses. */
  style: StyleProp<TextStyle>;
  accent: string;
  /** Accessibility label (the visible text is the field's own content). */
  label: string;
  inputRef?: RefObject<TextInput | null>;
}

/**
 * Multiline input that sizes itself to its text, so the card keeps its natural height while editing.
 *  - Native: a multiline `TextInput` without a fixed height is measured by its content on iOS and Android.
 *  - Web: a `<textarea>` has no intrinsic content height (and `scrollHeight` never shrinks), so an invisible mirror
 *    `Text` with identical typography gives the box its height and the textarea is laid over it.
 * The field draws no chrome of its own beyond a faint tint (accent while focused) that bleeds outside the text via
 * negative margins, so the text stays exactly where the read-only version puts it.
 */
export function AutoGrowInput({
  value,
  onChangeText,
  placeholder,
  placeholderColor,
  style,
  accent,
  label,
  inputRef,
}: AutoGrowInputProps) {
  const [focused, setFocused] = useState(false);
  const text = fieldFont(style);
  const size = typeof text.fontSize === 'number' ? text.fontSize : 15;
  const lineHeight = typeof text.lineHeight === 'number' ? text.lineHeight : Math.round(size * 1.35);

  const common: TextInputProps = {
    value,
    onChangeText,
    multiline: true,
    placeholder,
    placeholderTextColor: placeholderColor,
    selectionColor: accent,
    accessibilityLabel: label,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };
  const tint = {
    backgroundColor: focused ? withAlpha(accent, 0.14) : IDLE_TINT,
    borderColor: focused ? withAlpha(accent, 0.7) : 'transparent',
  };

  return (
    <View style={[styles.field, tint]}>
      {Platform.OS === 'web' ? (
        <View style={styles.webWrap}>
          <Text aria-hidden style={[text, styles.ghost, webCss({ userSelect: 'none' })]}>
            {`${value.length > 0 ? value : placeholder}​`}
          </Text>
          <TextInput
            {...common}
            ref={inputRef}
            style={[text, styles.webInput, noOutline, webCss({ caretColor: accent })]}
          />
        </View>
      ) : (
        <TextInput
          {...common}
          ref={inputRef}
          scrollEnabled={false}
          textAlignVertical="top"
          underlineColorAndroid="transparent"
          cursorColor={accent}
          style={[text, styles.nativeInput, { minHeight: lineHeight }]}
        />
      )}
    </View>
  );
}

export interface PreviewTextProps {
  value: string;
  editable: boolean;
  onChangeText?: (text: string) => void;
  placeholder: string;
  style: StyleProp<TextStyle>;
  /** Placeholder / empty-state colour. */
  mutedColor: string;
  accent: string;
  label: string;
  /** Read-only clamp (compact cards). */
  maxLines?: number;
  /** Inline nodes before / after the text while read-only (Instagram handle, hashtags). */
  prefix?: ReactNode;
  suffix?: ReactNode;
  /** Editable only: lets a card move focus between its fields (Reddit title -> body). */
  inputRef?: RefObject<TextInput | null>;
}

/** Selectable `Text` when read-only (muted placeholder when empty), in-place `AutoGrowInput` when editable. */
export function PreviewText({
  value,
  editable,
  onChangeText,
  placeholder,
  style,
  mutedColor,
  accent,
  label,
  maxLines,
  prefix,
  suffix,
  inputRef,
}: PreviewTextProps) {
  if (editable) {
    return (
      <AutoGrowInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderColor={mutedColor}
        style={style}
        accent={accent}
        label={label}
        inputRef={inputRef}
      />
    );
  }
  const empty = value.trim().length === 0;
  // A clamped (compact) card shows as much copy as fits, so blank lines between paragraphs collapse.
  const shown = maxLines !== undefined ? value.replace(/\n(?:[ \t]*\n)+/g, '\n') : value;
  return (
    <Text style={style} selectable numberOfLines={maxLines}>
      {prefix}
      {empty ? <Text style={{ color: mutedColor }}>{placeholder}</Text> : shown}
      {suffix}
    </Text>
  );
}

export interface HashtagsFieldProps {
  /** Hashtags without "#". */
  tags: string[];
  onChangeTags?: (tags: string[]) => void;
  /** Text colour: the platform's hashtag colour. */
  color: string;
  mutedColor: string;
  accent: string;
  fill: string;
  borderColor: string;
  /** Rendered at the right edge of the field (X's character counter). */
  trailing?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

const TAG_FONT: TextStyle = { fontSize: 14, lineHeight: 20, fontWeight: '600' };

/**
 * Small "Hashtags" input. It keeps its own raw text, so typing `#a #b` or a trailing space is never fought by
 * re-formatting, and reports `parseHashtags(text)` upward. When the parent swaps the tags for something the user
 * did not type (another draft, a regeneration) the raw text is replaced.
 */
export function HashtagsField({
  tags,
  onChangeTags,
  color,
  mutedColor,
  accent,
  fill,
  borderColor,
  trailing,
  style,
}: HashtagsFieldProps) {
  const [raw, setRaw] = useState(() => hashtagsText(tags));
  const [focused, setFocused] = useState(false);
  const key = tags.join('\u0001');

  useEffect(() => {
    setRaw((cur) => (parseHashtags(cur).join('\u0001') === key ? cur : hashtagsText(tags)));
    // Only a change of the tags themselves (not of `raw`) may overwrite what the user is typing.
  }, [key]);

  const font = fieldFont({ ...TAG_FONT, color });

  return (
    <View style={style}>
      <Text style={[styles.tagsLabel, { color: mutedColor }]}>Hashtags</Text>
      <View
        style={[
          styles.tagsBox,
          { backgroundColor: fill, borderColor: focused ? withAlpha(accent, 0.8) : borderColor },
        ]}
      >
        <Ionicons name="pricetag-outline" size={15} color={mutedColor} />
        <TextInput
          value={raw}
          onChangeText={(t) => {
            setRaw(t);
            onChangeTags?.(parseHashtags(t));
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="#launch #smallbiz"
          placeholderTextColor={mutedColor}
          selectionColor={accent}
          cursorColor={accent}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="done"
          underlineColorAndroid="transparent"
          accessibilityLabel="Hashtags"
          style={[styles.tagsInput, font, noOutline, webCss({ caretColor: accent })]}
        />
        {trailing}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Tint bleeds 7px / 3px outside the text; the negative margin cancels padding + border, so layout is unchanged.
  field: {
    alignSelf: 'stretch',
    marginHorizontal: -7,
    marginVertical: -3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderRadius: 10,
  },
  webWrap: { alignSelf: 'stretch' },
  ghost: { opacity: 0 },
  webInput: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, margin: 0, padding: 0, overflow: 'hidden' },
  nativeInput: { padding: 0, margin: 0 },

  tagsLabel: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 5 },
  tagsBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderRadius: 10,
  },
  tagsInput: { flex: 1, minWidth: 0, minHeight: 36, padding: 0, margin: 0 },
});
