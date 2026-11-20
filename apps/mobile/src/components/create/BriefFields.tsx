import { StyleSheet, Text, View } from 'react-native';

import { colors, space, type as t } from '@/src/theme';
import { Chip, ChipStrip, TextField } from '@/src/ui';

import { BRIEF_MAX, TONES } from './logic';

/** The free-text brief (with a character counter) and the optional tone. */
export function BriefFields({
  brief,
  onBrief,
  tone,
  onTone,
  disabled,
}: {
  brief: string;
  onBrief: (text: string) => void;
  /** Lowercase tone word, or null. */
  tone: string | null;
  onTone: (tone: string | null) => void;
  disabled?: boolean;
}) {
  const nearLimit = brief.length >= BRIEF_MAX * 0.9;
  return (
    <View style={styles.wrap}>
      <View>
        <TextField
          label="Brief"
          placeholder="What should the posts say? (optional)"
          value={brief}
          onChangeText={onBrief}
          multiline
          maxLength={BRIEF_MAX}
          editable={!disabled}
          accessibilityLabel="Brief: what should the posts say? Optional."
        />
        <Text style={[styles.counter, nearLimit && styles.counterWarn]} accessibilityLabel={`${brief.length} of ${BRIEF_MAX} characters`}>
          {`${brief.length}/${BRIEF_MAX}`}
        </Text>
      </View>
      <View style={styles.tone}>
        <Text style={t.label}>Tone (optional)</Text>
        <ChipStrip>
          {TONES.map((label) => {
            const value = label.toLowerCase();
            const selected = tone === value;
            return (
              <Chip
                key={value}
                label={label}
                selected={selected}
                disabled={disabled}
                onPress={() => onTone(selected ? null : value)}
              />
            );
          })}
        </ChipStrip>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.lg },
  counter: {
    alignSelf: 'flex-end',
    marginTop: 6,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMute,
    fontVariant: ['tabular-nums'],
  },
  counterWarn: { color: colors.warn },
  tone: { gap: space.sm },
});
