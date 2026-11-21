/**
 * The connect sheet: `ConnectAccounts` in a dialog, opened from anywhere (the Dashboard call to action, a "Connect" or
 * "Update" button on a card, or a web `#connect=<platform>` link). Mount `ConnectSheetProvider` once, above the navigator
 * (it sits inside the session and toast providers); everything else uses `useConnectSheet()`.
 *
 * The dialog is a transparent `Modal`: a phone gets a bottom sheet, a wide window a centred card. Feedback inside it is
 * inline (a toast would draw underneath a native modal).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform as RNPlatform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useWide } from '@/src/layout';
import { useIsDemoWorkspace, useSession } from '@/src/session';
import { colors, radius, space, type as t } from '@/src/theme';
import type { Platform } from '@/src/types';
import { Button } from '@/src/ui';
import { ConnectAccounts } from './ConnectAccounts';
import { ConnectSheetContext, useConnectSheet, type ConnectSheetApi } from './sheetContext';

export { useConnectSheet, type ConnectSheetApi };

export function ConnectSheetProvider({ children }: { children: ReactNode }) {
  const { status, connectRequest, clearConnectRequest } = useSession();
  const [isOpen, setOpen] = useState(false);
  const [platform, setPlatform] = useState<Platform | null>(null);
  // Remounts the dialog's content on every open, so it never shows the previous visit's half-typed numbers.
  const [session, setSession] = useState(0);
  const [version, setVersion] = useState(0);

  const open = useCallback((target?: Platform | null) => {
    setPlatform(target ?? null);
    setSession((n) => n + 1);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const markSaved = useCallback(() => setVersion((n) => n + 1), []);

  // A web `/#ws=<token>&connect=<platform>` link (what an app without the image picker opens in the browser).
  useEffect(() => {
    if (status !== 'ready' || !connectRequest) return;
    open(connectRequest);
    clearConnectRequest();
  }, [status, connectRequest, clearConnectRequest, open]);

  // Leaving the workspace (reset, expired token) closes the dialog.
  useEffect(() => {
    if (status !== 'ready') setOpen(false);
  }, [status]);

  const api = useMemo<ConnectSheetApi>(
    () => ({ open, close, isOpen, version, markSaved }),
    [open, close, isOpen, version, markSaved],
  );

  return (
    <ConnectSheetContext.Provider value={api}>
      {children}
      {isOpen ? <ConnectDialog key={session} initialPlatform={platform} onClose={close} /> : null}
    </ConnectSheetContext.Provider>
  );
}

function ConnectDialog({ initialPlatform, onClose }: { initialPlatform: Platform | null; onClose: () => void }) {
  const wide = useWide();
  const insets = useSafeAreaInsets();
  const demo = useIsDemoWorkspace();
  return (
    <Modal transparent animationType={RNPlatform.OS === 'web' ? 'fade' : 'slide'} onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView
        style={[styles.overlay, wide ? styles.overlayWide : styles.overlayNarrow]}
        behavior={RNPlatform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Tap outside the card to close. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
        <View
          style={[styles.sheet, wide ? styles.sheetWide : styles.sheetNarrow, { paddingBottom: Math.max(insets.bottom, space.lg) }]}
          accessibilityViewIsModal
        >
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={t.h2} accessibilityRole="header">
                {demo ? 'Connect your demo accounts' : 'Connect your real accounts'}
              </Text>
              <Text style={t.small}>
                {demo
                  ? 'Sign in with the demo account and Pulse shows synthetic numbers. Nothing is sent to any platform.'
                  : 'Connect an account and Pulse reads your numbers for you. A screenshot is the fallback.'}
              </Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} onPress={onClose} style={styles.close}>
              <Ionicons name="close" size={20} color={colors.textDim} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <ConnectAccounts initialPlatform={initialPlatform} />
          </ScrollView>
          <Button title="Done" variant="secondary" onPress={onClose} full />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  sheetWide: { width: '100%', maxWidth: 600, maxHeight: '90%', borderRadius: radius.lg },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  headerText: { flex: 1, minWidth: 0, gap: 2 },
  close: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cardHi,
  },
  scroll: { flexShrink: 1 },
  scrollContent: { paddingBottom: space.sm },
});
