/**
 * The editable numbers form inside a platform card. Two uses:
 *  - after a screenshot: prefilled with what Claude read, under "Read by Claude, check before saving";
 *  - "Type numbers": empty (or the saved handle and followers), optionally under a note on why reading failed.
 * Presentational only: `ConnectAccounts` owns the state and the requests.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image, StyleSheet, Text, View } from 'react-native';

import {
  confidenceNote,
  HANDLE_PLACEHOLDER,
  MAX_HANDLE,
  PERIODS,
  platformMismatch,
  type FormErrors,
  type NumbersForm,
} from '@/src/connect';
import { colors, platformMeta, radius, space, type as t, withAlpha } from '@/src/theme';
import type { Platform, ScreenshotRead } from '@/src/types';
import { Button, Chip, ChipRow, TextField } from '@/src/ui';

export interface NumbersFormViewProps {
  platform: Platform;
  form: NumbersForm;
  errors: FormErrors;
  /** What Claude read; null when the person is typing. */
  read: ScreenshotRead | null;
  /** How many recent posts from the screenshot are saved along with the numbers. */
  postsCount: number;
  /** The uploaded screenshot, as a thumbnail to compare against. */
  thumb: string | null;
  /** Why we are asking for typed numbers (the 503 text, or an unreadable image). */
  notice: string | null;
  saving: boolean;
  saveError: string | null;
  onChange: (patch: Partial<NumbersForm>) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function NumbersFormView({
  platform,
  form,
  errors,
  read,
  postsCount,
  thumb,
  notice,
  saving,
  saveError,
  onChange,
  onSave,
  onCancel,
}: NumbersFormViewProps) {
  const label = platformMeta[platform].label;
  const mismatch = read ? platformMismatch(read) : null;
  const caution = read ? confidenceNote(read) : null;

  return (
    <View style={styles.form} testID={`connect-form-${platform}`}>
      {notice ? <Banner tone="warn" icon="alert-circle-outline" text={notice} /> : null}

      {read ? (
        <View style={styles.readRow}>
          {thumb ? (
            <Image source={{ uri: thumb }} style={styles.thumb} resizeMode="cover" accessibilityLabel="Your screenshot" />
          ) : null}
          <View style={styles.readText}>
            <View style={styles.readLine}>
              <Ionicons name="sparkles" size={14} color={colors.accent} />
              <Text style={styles.readTitle}>
                {read.ai_used ? 'Read by Claude, check before saving' : `Read from your ${label} page, check before saving`}
              </Text>
            </View>
            {read.notes ? <Text style={t.small}>{read.notes}</Text> : null}
            {caution ? <Text style={[t.small, { color: colors.warn }]}>{caution}</Text> : null}
          </View>
        </View>
      ) : (
        <View style={styles.readRow}>
          {thumb ? (
            <Image source={{ uri: thumb }} style={styles.thumb} resizeMode="cover" accessibilityLabel="Your screenshot" />
          ) : null}
          <View style={styles.readText}>
            <Text style={styles.readTitle}>Type your numbers</Text>
            <Text style={t.small}>{`Copy them from your ${label} profile or insights. Leave blank what you don't have.`}</Text>
          </View>
        </View>
      )}

      {mismatch ? <Banner tone="warn" icon="warning-outline" text={mismatch} /> : null}

      <TextField
        label={`${label} handle`}
        value={form.handle}
        onChangeText={(handle) => onChange({ handle })}
        placeholder={HANDLE_PLACEHOLDER[platform]}
        maxLength={MAX_HANDLE + 1}
        autoCapitalize="none"
        autoCorrect={false}
        error={errors.handle}
        editable={!saving}
        accessibilityLabel={`${label} handle`}
      />

      <View style={styles.grid}>
        <Field label="Followers" value={form.followers} error={errors.followers} disabled={saving} onChange={(followers) => onChange({ followers })} />
        <Field label="Views" value={form.views} error={errors.views} disabled={saving} onChange={(views) => onChange({ views })} />
        <Field
          label="Engagements (total)"
          value={form.engagements}
          error={errors.engagements}
          disabled={saving}
          onChange={(engagements) => onChange({ engagements })}
        />
        <Field label="Likes" value={form.likes} error={errors.likes} disabled={saving} onChange={(likes) => onChange({ likes })} />
        <Field
          label="Comments"
          value={form.comments}
          error={errors.comments}
          disabled={saving}
          onChange={(comments) => onChange({ comments })}
        />
        <Field label="Shares" value={form.shares} error={errors.shares} disabled={saving} onChange={(shares) => onChange({ shares })} />
        <Field
          label="Profile views"
          value={form.profileViews}
          error={errors.profileViews}
          disabled={saving}
          onChange={(profileViews) => onChange({ profileViews })}
        />
      </View>

      <Text style={t.small}>
        Your insights show likes, comments and shares apart? Fill them in and leave the total blank: Pulse adds them up
        and shows Engagements broken down.
      </Text>

      <View style={styles.period}>
        <Text style={t.label}>Views, engagements and profile views cover the last</Text>
        <ChipRow>
          {PERIODS.map((p) => (
            <Chip
              key={p}
              small
              label={`${p} days`}
              selected={form.period === p}
              disabled={saving}
              onPress={() => onChange({ period: p })}
            />
          ))}
        </ChipRow>
      </View>

      {postsCount > 0 ? (
        <Text style={t.small}>{`Also found ${postsCount} recent ${postsCount === 1 ? 'post' : 'posts'}. They are saved with these numbers.`}</Text>
      ) : null}

      {errors.form ? <Banner tone="error" icon="alert-circle" text={errors.form} /> : null}
      {saveError ? <Banner tone="error" icon="alert-circle" text={saveError} /> : null}

      <View style={styles.actions}>
        <Button title="Save" icon="checkmark" loading={saving} onPress={onSave} style={styles.save} />
        <Button title="Cancel" variant="ghost" disabled={saving} onPress={onCancel} />
      </View>
    </View>
  );
}

function Field({
  label,
  value,
  error,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  return (
    <TextField
      style={styles.field}
      label={label}
      value={value}
      onChangeText={onChange}
      placeholder="0"
      keyboardType="number-pad"
      autoCorrect={false}
      maxLength={16}
      error={error}
      editable={!disabled}
      accessibilityLabel={label}
    />
  );
}

type BannerTone = 'warn' | 'error' | 'info';
const TONE: Record<BannerTone, string> = { warn: colors.warn, error: colors.danger, info: colors.info };

/** A short coloured note: why reading failed, a platform mismatch, a validation or save error. */
export function Banner({ tone, icon, text }: { tone: BannerTone; icon: 'alert-circle-outline' | 'warning-outline' | 'alert-circle' | 'information-circle-outline'; text: string }) {
  const c = TONE[tone];
  return (
    <View
      style={[styles.banner, { backgroundColor: withAlpha(c, 0.1), borderColor: withAlpha(c, 0.4) }]}
      accessibilityRole={tone === 'info' ? undefined : 'alert'}
    >
      <Ionicons name={icon} size={16} color={c} style={styles.bannerIcon} />
      <Text style={[t.small, styles.bannerText]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.md },
  readRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  readText: { flex: 1, minWidth: 0, gap: 2 },
  readLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  readTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: colors.cardHi },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  field: { flexGrow: 1, flexBasis: 140, minWidth: 0 },
  period: { gap: 6 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  save: { minWidth: 120 },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  bannerIcon: { marginTop: 1 },
  bannerText: { flex: 1, minWidth: 0, color: colors.text },
});
