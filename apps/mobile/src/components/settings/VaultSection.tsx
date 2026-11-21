/**
 * Settings > Saved logins (docs/VAULT.md). Save, replace or delete a platform login kept in the phone's secure store.
 * A saved value is never shown again: the sheet below owns the typed username / password and drops them on close.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform as RNPlatform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fmtDay } from '@/src/format';
import { useWide } from '@/src/layout';
import { colors, platformMeta, radius, space, type as t } from '@/src/theme';
import { PLATFORMS, type Platform } from '@/src/types';
import { Button, Card, PlatformLabel, SectionHeader, TextField, confirm, useToast } from '@/src/ui';
import { MAX_FIELD, deleteLogin, saveLogin, useVaultStatus } from '@/src/vault';

export function VaultSection() {
  const { available, saved } = useVaultStatus();
  const toast = useToast();
  const [editing, setEditing] = useState<Platform | null>(null);

  const header = (
    <SectionHeader
      title="Saved logins"
      subtitle="Encrypted on this phone. Pulse's servers and Claude never see it. You can't view it again, only replace it."
    />
  );

  if (RNPlatform.OS === 'web' || !available) {
    return (
      <View style={styles.section}>
        {header}
        <Card>
          <Text style={t.dim}>
            {RNPlatform.OS === 'web' ? 'Saved logins live only in the Pulse phone app.' : 'Update the app to save logins.'}
          </Text>
        </Card>
      </View>
    );
  }

  const remove = async (p: Platform) => {
    const ok = await confirm(
      'Delete saved login?',
      `Pulse forgets the ${platformMeta[p].label} login saved on this phone.`,
      'Delete',
      true,
    );
    if (!ok) return;
    await deleteLogin(p);
    toast.show('Login deleted');
  };

  return (
    <View style={styles.section}>
      {header}
      <Card style={styles.list}>
        {PLATFORMS.map((p) => {
          const info = saved[p];
          return (
            <View key={p} style={styles.row}>
              <View style={styles.rowText}>
                <PlatformLabel platform={p} />
                <Text style={t.small}>{info ? `Login saved · ${fmtDay(info.savedAt)}` : 'No login saved'}</Text>
              </View>
              <View style={styles.actions}>
                {info ? (
                  <>
                    <Button title="Replace" variant="secondary" small onPress={() => setEditing(p)} />
                    <Button title="Delete" variant="danger" small onPress={() => void remove(p)} />
                  </>
                ) : (
                  <Button title="Save login" small onPress={() => setEditing(p)} />
                )}
              </View>
            </View>
          );
        })}
      </Card>
      {editing ? (
        <LoginSheet key={editing} platform={editing} replacing={!!saved[editing]} onClose={() => setEditing(null)} />
      ) : null}
    </View>
  );
}

function LoginSheet({ platform, replacing, onClose }: { platform: Platform; replacing: boolean; onClose: () => void }) {
  const wide = useWide();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const label = platformMeta[platform].label;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The typed values never outlive the sheet.
  useEffect(
    () => () => {
      setUsername('');
      setPassword('');
    },
    [],
  );

  const close = () => {
    setUsername('');
    setPassword('');
    onClose();
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveLogin(platform, username, password);
      setUsername('');
      setPassword('');
      onClose();
      toast.show('Login saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the login.");
      setPassword('');
      setBusy(false);
    }
  };

  const noAssist = {
    autoComplete: 'off',
    importantForAutofill: 'no',
    textContentType: 'none',
    autoCapitalize: 'none',
    autoCorrect: false,
    spellCheck: false,
    maxLength: MAX_FIELD,
  } as const;

  return (
    <Modal transparent animationType="slide" onRequestClose={close} statusBarTranslucent>
      <KeyboardAvoidingView
        style={[styles.overlay, wide ? styles.overlayWide : styles.overlayNarrow]}
        behavior={RNPlatform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close" accessibilityRole="button" />
        <View
          style={[styles.sheet, wide ? styles.sheetWide : styles.sheetNarrow, { paddingBottom: Math.max(insets.bottom, space.lg) }]}
          accessibilityViewIsModal
        >
          <View style={styles.header}>
            <Text style={[t.h2, styles.headerText]} accessibilityRole="header">
              {replacing ? `Replace ${label} login` : `Save ${label} login`}
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} onPress={close} style={styles.close}>
              <Ionicons name="close" size={20} color={colors.textDim} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.fields} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <TextField
              label="Username or email"
              value={username}
              onChangeText={setUsername}
              {...noAssist}
            />
            <TextField
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder={replacing ? '•••••••• (stored; type a new one)' : undefined}
              error={error}
              {...noAssist}
            />
            <Text style={t.small}>Pulse signs you in only after you approve it on the sign-in screen.</Text>
          </ScrollView>
          <View style={styles.buttons}>
            <Button title="Cancel" variant="secondary" onPress={close} style={styles.btn} />
            <Button title="Save" loading={busy} onPress={() => void save()} style={styles.btn} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  list: { padding: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    padding: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowText: { flex: 1, minWidth: 0, gap: 4 },
  actions: { flexDirection: 'row', gap: space.sm },
  overlay: { flex: 1, backgroundColor: colors.overlay },
  overlayNarrow: { justifyContent: 'flex-end' },
  overlayWide: { justifyContent: 'center', alignItems: 'center', padding: space.xl },
  sheet: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.borderHi,
    paddingTop: space.lg,
    paddingHorizontal: space.lg,
    gap: space.md,
  },
  sheetNarrow: { maxHeight: '92%', borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  sheetWide: { width: '100%', maxWidth: 480, maxHeight: '90%', borderRadius: radius.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  headerText: { flex: 1, minWidth: 0 },
  close: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cardHi,
  },
  fields: { gap: space.md, paddingBottom: space.sm },
  buttons: { flexDirection: 'row', gap: space.sm },
  btn: { flex: 1 },
});
