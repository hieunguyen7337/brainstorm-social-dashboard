/**
 * Settings > Claude (phone only): the person's own Anthropic API key and the model the Assistant uses. The key is typed
 * once, kept in the phone's secure store and never shown again (only "sk-ant-…WXYZ"). The web build renders nothing.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type as t } from '@/src/theme';
import { Button, Card, SectionHeader, TextField, confirm, useToast } from '@/src/ui';

import { testApiKey } from './client';
import { keyProblem } from './key';
import { deleteApiKey, readApiKey, saveApiKey, useApiKeyStatus } from './keyStore';
import { MODELS, type ModelId } from './models';
import { saveModel, useModel } from './modelStore';

export function ClaudeKeySection() {
  const status = useApiKeyStatus();
  const model = useModel();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null);

  // The typed key never outlives the screen.
  useEffect(() => () => setDraft(''), []);

  const header = (
    <SectionHeader
      title="Claude API key"
      subtitle="Powers the Assistant tab. Your own Anthropic key, stored encrypted on this phone only: requests go straight to Anthropic, never through Pulse's servers, and the key can't be viewed again."
    />
  );

  if (!status.available) {
    return (
      <View style={styles.section}>
        {header}
        <Card>
          <Text style={t.dim}>Update the app to use the Assistant with your own Claude API key.</Text>
        </Card>
      </View>
    );
  }

  const save = async () => {
    const problem = keyProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveApiKey(draft);
      setDraft('');
      setTestNote(null);
      toast.show('Key saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the key. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm('Remove key?', 'Pulse forgets the Claude API key on this phone. The Assistant stops working until you add one.', 'Remove', true);
    if (!ok) return;
    await deleteApiKey();
    setTestNote(null);
    toast.show('Key removed');
  };

  const test = async () => {
    setTesting(true);
    setTestNote(null);
    try {
      const key = await readApiKey();
      if (!key) {
        setTestNote({ ok: false, text: "Couldn't read the saved key. Save it again." });
        return;
      }
      const res = await testApiKey(key, model);
      setTestNote(res.ok ? { ok: true, text: 'The key works.' } : { ok: false, text: res.failure.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <View style={styles.section}>
      {header}
      <Card style={styles.card}>
        {status.hint ? (
          <Text style={t.body} testID="claude-key-hint">{`Key saved: ${status.hint}`}</Text>
        ) : (
          <Text style={t.dim}>No key saved yet. Create one at console.anthropic.com.</Text>
        )}
        <TextField
          label={status.hint ? 'Replace key' : 'Anthropic API key'}
          value={draft}
          onChangeText={(v) => {
            setDraft(v);
            setError(null);
          }}
          placeholder="sk-ant-..."
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          error={error}
          editable={!busy}
        />
        <View style={styles.actions}>
          <Button small title={status.hint ? 'Replace key' : 'Save key'} icon="key" disabled={!draft.trim()} loading={busy} onPress={() => void save()} />
          {status.hint ? (
            <>
              <Button small variant="secondary" title="Test key" loading={testing} onPress={() => void test()} />
              <Button small variant="danger" title="Remove" onPress={() => void remove()} />
            </>
          ) : null}
        </View>
        {testNote ? (
          <Text style={[t.small, { color: testNote.ok ? colors.success : colors.danger }]} accessibilityRole="alert">
            {testNote.text}
          </Text>
        ) : null}
        <View style={styles.models}>
          <Text style={t.label}>Model</Text>
          {MODELS.map((m) => {
            const on = m.id === model;
            return (
              <Pressable
                key={m.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={m.label}
                onPress={() => void saveModel(m.id as ModelId)}
                style={[styles.model, on && styles.modelOn]}
                testID={`claude-model-${m.id}`}
              >
                <Text style={[t.body, on && styles.modelTextOn]}>{m.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  card: { gap: space.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  models: { gap: space.sm },
  model: { padding: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  modelOn: { borderColor: colors.accent, backgroundColor: colors.cardHi },
  modelTextOn: { fontWeight: '700' },
});
