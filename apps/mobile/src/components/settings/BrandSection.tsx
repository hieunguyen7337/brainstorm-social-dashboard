import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { api, ApiError, type WorkspacePatch } from '@/src/api';
import { useSession } from '@/src/session';
import { colors, radius, space, withAlpha } from '@/src/theme';
import { Button, Card, SectionHeader, SkeletonCard, TextField, useToast } from '@/src/ui';

type Field = 'brand_name' | 'brand_voice' | 'audience' | 'offer' | 'product_url';
type Edits = Partial<Record<Field, string>>;
type Stored = Record<Field, string>;

const FIELDS: readonly Field[] = ['brand_name', 'brand_voice', 'audience', 'offer', 'product_url'];

/** Generous caps: these strings are pasted into every Claude prompt. */
const MAX_LEN: Record<Field, number> = {
  brand_name: 80,
  brand_voice: 600,
  audience: 400,
  offer: 300,
  product_url: 300,
};

/** "example.com" -> "https://example.com"; anything that already has a scheme is left alone. */
export function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
}

const URL_RE = /^https?:\/\/[^\s/?#:]+\.[^\s/?#:.]{2,}(:\d{1,5})?([/?#]\S*)?$/i;

/** Lenient http(s) check: a dotted host with a 2+ letter ending, optional port and path. */
export const isValidUrl = (v: string): boolean => URL_RE.test(v);

function fieldError(field: Field, value: string): string | null {
  if (field === 'brand_name' && value === '') return "Brand name can't be empty.";
  if (field === 'product_url' && value !== '' && !isValidUrl(normalizeUrl(value))) {
    return 'Enter a web address like https://example.com.';
  }
  return null;
}

/**
 * Diff the edited draft against the saved workspace. Only fields whose trimmed text really differs end up in the
 * patch (so "dirty" means "has something to save"), and each changed field is validated.
 */
export function buildPatch(
  edits: Edits,
  stored: Stored | null,
): { patch: WorkspacePatch; errors: Partial<Record<Field, string>> } {
  const patch: WorkspacePatch = {};
  const errors: Partial<Record<Field, string>> = {};
  for (const field of FIELDS) {
    const raw = edits[field];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value === (stored?.[field] ?? '').trim()) continue;
    patch[field] = field === 'product_url' ? normalizeUrl(value) : value;
    const problem = fieldError(field, value);
    if (problem) errors[field] = problem;
  }
  return { patch, errors };
}

/**
 * Workspace profile form. The draft only holds fields the user touched (`edits`); everything else reads straight
 * from the session workspace, so there is no "sync from props" effect to get wrong.
 */
export function BrandSection() {
  const { workspace, setWorkspace } = useSession();
  const toast = useToast();
  const [edits, setEdits] = useState<Edits>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { patch, errors } = useMemo(() => buildPatch(edits, workspace), [edits, workspace]);
  const dirty = Object.keys(patch).length > 0;
  const invalid = Object.keys(errors).length > 0;

  const value = (field: Field): string => edits[field] ?? workspace?.[field] ?? '';
  const setField = (field: Field, text: string) => {
    setEdits((prev) => ({ ...prev, [field]: text }));
    setSaveError(null);
  };
  const discard = () => {
    setEdits({});
    setSaveError(null);
  };

  const save = async () => {
    if (!dirty || invalid || saving) return;
    const sent = edits;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.patchWorkspace(patch);
      setWorkspace(updated);
      // Drop the drafts we just saved; keep anything typed while the request was in flight.
      setEdits((prev) => {
        const next: Edits = {};
        for (const field of FIELDS) {
          const draft = prev[field];
          if (draft !== undefined && draft !== sent[field]) next[field] = draft;
        }
        return next;
      });
      toast.show('Brand profile saved');
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <SectionHeader
      title="Brand profile"
      subtitle="These fields steer every generated post: Claude uses your voice, audience and offer when writing."
    />
  );

  if (!workspace) {
    return (
      <View style={styles.section}>
        {header}
        <SkeletonCard lines={5} />
      </View>
    );
  }

  return (
    <View style={styles.section}>
      {header}
      <Card style={styles.card}>
        <TextField
          label="Brand name"
          value={value('brand_name')}
          onChangeText={(text) => setField('brand_name', text)}
          placeholder="Your brand"
          maxLength={MAX_LEN.brand_name}
          autoCapitalize="words"
          returnKeyType="done"
          error={errors.brand_name}
        />
        <TextField
          label="Brand voice"
          value={value('brand_voice')}
          onChangeText={(text) => setField('brand_voice', text)}
          placeholder="e.g. Warm, witty and plain-spoken. No buzzwords."
          maxLength={MAX_LEN.brand_voice}
          multiline
          inputStyle={styles.multiline}
        />
        <TextField
          label="Audience"
          value={value('audience')}
          onChangeText={(text) => setField('audience', text)}
          placeholder="e.g. Busy founders who want to grow without a marketing team."
          maxLength={MAX_LEN.audience}
          multiline
          inputStyle={styles.multiline}
        />
        <TextField
          label="Offer"
          value={value('offer')}
          onChangeText={(text) => setField('offer', text)}
          placeholder="e.g. Free 14-day trial"
          maxLength={MAX_LEN.offer}
          returnKeyType="done"
        />
        <TextField
          label="Product URL"
          value={value('product_url')}
          onChangeText={(text) => setField('product_url', text)}
          placeholder="https://yourbrand.com"
          maxLength={MAX_LEN.product_url}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          error={errors.product_url}
        />

        {saveError ? (
          <View style={styles.error} accessibilityRole="alert">
            <Ionicons name="alert-circle" size={16} color={colors.danger} />
            <Text style={styles.errorText}>{saveError}</Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Button
            title="Save changes"
            icon="checkmark"
            onPress={() => void save()}
            disabled={!dirty || invalid}
            loading={saving}
            style={styles.grow}
          />
          {dirty && !saving ? <Button title="Discard" variant="secondary" onPress={discard} /> : null}
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  card: { gap: space.lg },
  multiline: { minHeight: 80 },
  error: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: withAlpha(colors.danger, 0.4),
    backgroundColor: withAlpha(colors.danger, 0.1),
  },
  errorText: { flex: 1, fontSize: 13.5, lineHeight: 19, color: colors.danger },
  actions: { flexDirection: 'row', gap: space.md },
  grow: { flex: 1 },
});
