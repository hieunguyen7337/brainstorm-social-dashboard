/**
 * "How to sync real stats": a bottom sheet on phones and a centred dialog on wide screens. It explains the two ways
 * real numbers reach the workspace (the sync script, or Claude in Chrome over MCP) and what changes once they do.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Modal,
  Platform as RNPlatform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { publicBaseUrl } from '@/src/api';
import { APP_NAME, MAX_CONTENT_WIDTH } from '@/src/config';
import { useSession } from '@/src/session';
import { colors, radius, space, type as t, withAlpha } from '@/src/theme';
import { Button, IconButton, Skeleton, copyText, haptic, useToast } from '@/src/ui';
import { claudeChromePrompt, harvestCommand, maskSecret } from './harvest-command';

const MONO = RNPlatform.select({ ios: 'Menlo', default: 'monospace' });
const WEB = RNPlatform.OS === 'web';

// ---- the button that opens the sheet --------------------------------------------------------------------------------

/**
 * The section-level text button under the Connectors subtitle (info icon, accent text). `loading` holds its place
 * while the harvest status is still on its way, so the section does not jump when it lands.
 */
export function HarvestHowToButton({ onPress, loading }: { onPress: () => void; loading?: boolean }) {
  if (loading) {
    return (
      <View style={styles.how}>
        <Skeleton width={168} height={14} />
      </View>
    );
  }
  return (
    <Pressable
      testID="harvest-how-to"
      accessibilityRole="button"
      accessibilityLabel="How to sync real stats"
      hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
      onPress={() => {
        haptic.select();
        onPress();
      }}
      style={({ pressed }) => [styles.how, pressed && styles.pressed]}
    >
      <Ionicons name="information-circle-outline" size={18} color={colors.accent} />
      <Text style={styles.howText}>How to sync real stats</Text>
    </Pressable>
  );
}

// ---- copy with feedback inside the sheet ----------------------------------------------------------------------------

type CopyKey = 'command' | 'prompt';
type CopyResult = { key: CopyKey; ok: boolean } | null;

/**
 * Copy with a toast, plus feedback on the button itself: the toast host lives behind a Modal, so inside the sheet the
 * button is what tells the user it worked.
 */
function useCopy() {
  const toast = useToast();
  const [result, setResult] = useState<CopyResult>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (key: CopyKey, text: string, done: string) => {
      const ok = await copyText(text);
      toast.show(ok ? done : "Couldn't copy to the clipboard.", ok ? 'success' : 'error');
      setResult({ key, ok });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setResult(null), 1800);
    },
    [toast],
  );
  return { result, copy };
}

const copyTitle = (r: CopyResult, key: CopyKey, idle: string): string =>
  r?.key !== key ? idle : r.ok ? 'Copied' : "Couldn't copy";
const copyIcon = (r: CopyResult, key: CopyKey): 'copy-outline' | 'checkmark' =>
  r?.key === key && r.ok ? 'checkmark' : 'copy-outline';

// ---- the sheet ------------------------------------------------------------------------------------------------------

export function HarvestSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { token, mock } = useSession();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { result, copy } = useCopy();
  const [revealed, setRevealed] = useState(false);

  // Never leave a revealed token behind for the next time the sheet opens.
  useEffect(() => {
    if (!visible) setRevealed(false);
  }, [visible]);

  const base = publicBaseUrl();
  const fullCommand = harvestCommand(base, token);
  const shownCommand = harvestCommand(base, token ? (revealed ? token : maskSecret(token)) : null);
  const prompt = claudeChromePrompt(APP_NAME);
  // A bottom sheet up to 767px wide (phones, a 720px column); a centred dialog beyond.
  const wide = width >= MAX_CONTENT_WIDTH + 2 * space.xl;

  return (
    <Modal
      visible={visible}
      transparent
      animationType={WEB ? 'fade' : 'slide'}
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View style={[styles.root, wide ? styles.rootCentered : styles.rootBottom]}>
        {/* Tapping outside the panel closes the sheet. Not a tab stop (react-native-web's Pressable ignores
            `focusable` and always sets a tabIndex, so say -1 explicitly): the panel has its own Close button. */}
        <Pressable
          testID="harvest-sheet-backdrop"
          accessible={false}
          tabIndex={-1}
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />

        <View
          testID="harvest-sheet"
          accessibilityViewIsModal
          style={[
            styles.panel,
            wide ? styles.panelDialog : styles.panelSheet,
            { maxHeight: Math.round(height * 0.9) },
          ]}
        >
          {wide ? null : <View style={styles.grabber} />}
          <View style={[styles.head, wide && styles.headDialog]}>
            <View style={styles.headIcon}>
              <Ionicons name="sync-outline" size={20} color={colors.accent} />
            </View>
            <Text style={[t.h2, styles.title]} accessibilityRole="header">
              How to sync real stats
            </Text>
            <IconButton icon="close" label="Close" onPress={onClose} />
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.body, { paddingBottom: space.xl + insets.bottom }]}
          >
            {mock ? (
              <View style={styles.note}>
                <Ionicons name="cloud-offline-outline" size={16} color={colors.textMute} style={styles.noteIcon} />
                <Text style={[t.small, styles.noteText]}>
                  Offline demo (mock data): syncing real stats needs the live server.
                </Text>
              </View>
            ) : null}

            <Text style={t.dim}>
              {`Replace simulated numbers with the real ones from your LinkedIn and Instagram posts in ${APP_NAME}.`}
            </Text>

            <Step n={1} title="Save your profile links">
              <Text style={t.dim}>Add your LinkedIn and Instagram profile links in the Connectors list above.</Text>
            </Step>

            <Step n={2} title="Run the sync script">
              <Text style={t.dim}>
                Run this in a terminal on your computer. It reads your latest post numbers and sends them to this
                workspace.
              </Text>
              <View style={styles.blockHead}>
                <Text style={t.label}>Command</Text>
                {token ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={revealed ? 'Hide token' : 'Reveal token'}
                    hitSlop={10}
                    onPress={() => {
                      haptic.select();
                      setRevealed((r) => !r);
                    }}
                    style={({ pressed }) => [styles.reveal, pressed && styles.pressed]}
                  >
                    <Ionicons name={revealed ? 'eye-off-outline' : 'eye-outline'} size={16} color={colors.accent} />
                    <Text style={styles.revealText}>{revealed ? 'Hide' : 'Reveal'}</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.code}>
                <Text testID="harvest-command" style={styles.codeText} selectable={revealed}>
                  {shownCommand}
                </Text>
              </View>
              <Button
                title={copyTitle(result, 'command', 'Copy command')}
                icon={copyIcon(result, 'command')}
                disabled={!token}
                onPress={() => void copy('command', fullCommand, 'Command copied')}
                full
              />
              <View style={styles.warn}>
                <Ionicons name="lock-closed-outline" size={13} color={colors.textMute} style={styles.warnIcon} />
                <Text style={[t.small, styles.warnText]}>The command contains your workspace token. Keep it private.</Text>
              </View>
            </Step>

            <Step n={3} title="Or ask Claude in Chrome via MCP">
              <Text style={t.dim}>
                {`Connect Claude with the “Connect Claude (MCP)” card further down Settings. Then open your profile in Claude in Chrome and ask it to read your latest post numbers and send them to ${APP_NAME}. For example:`}
              </Text>
              <View style={styles.prompt}>
                <Text testID="harvest-prompt" style={styles.promptText} selectable>
                  {prompt}
                </Text>
              </View>
              <Button
                title={copyTitle(result, 'prompt', 'Copy prompt')}
                icon={copyIcon(result, 'prompt')}
                variant="secondary"
                onPress={() => void copy('prompt', prompt, 'Prompt copied')}
                full
              />
            </Step>

            <Step n={4} title="What changes">
              <Text style={t.dim}>
                {'Posts that carry real numbers get a '}
                <Text style={styles.em}>Real data</Text>
                {' badge, and Insights learns from them. All your other posts stay simulated.'}
              </Text>
            </Step>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}>
        <Text style={styles.stepNumText}>{n}</Text>
      </View>
      <View style={styles.stepBody}>
        <Text style={styles.stepTitle}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // the button
  how: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  howText: { fontSize: 14, fontWeight: '700', color: colors.accent },
  pressed: { opacity: 0.7 },

  // the sheet
  root: { flex: 1, alignItems: 'center', backgroundColor: colors.overlay },
  rootBottom: { justifyContent: 'flex-end' },
  rootCentered: { justifyContent: 'center', padding: space.xl },
  panel: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  panelSheet: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderBottomWidth: 0 },
  panelDialog: { borderRadius: radius.lg },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    marginTop: space.sm,
    backgroundColor: colors.borderHi,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headDialog: { paddingTop: space.lg },
  headIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(colors.accent, 0.16),
  },
  title: { flex: 1, minWidth: 0 },
  scroll: { flexShrink: 1 },
  body: { padding: space.lg, gap: space.lg },

  // notes
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  noteIcon: { marginTop: 2 },
  noteText: { flex: 1, color: colors.textMute },

  // steps
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(colors.accent, 0.2),
  },
  stepNumText: { fontSize: 12.5, fontWeight: '800', color: colors.accent },
  stepBody: { flex: 1, minWidth: 0, gap: space.sm },
  stepTitle: { ...t.h3, lineHeight: 24 },
  em: { fontWeight: '700', color: colors.text },

  // command + prompt
  blockHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 24, marginTop: space.xs },
  reveal: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28 },
  revealText: { fontSize: 13, fontWeight: '700', color: colors.accent },
  code: {
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  codeText: { ...t.mono, fontFamily: MONO },
  prompt: {
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  promptText: { fontSize: 14, lineHeight: 20, color: colors.text },
  warn: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  warnIcon: { marginTop: 2 },
  warnText: { flex: 1, color: colors.textMute },
});
