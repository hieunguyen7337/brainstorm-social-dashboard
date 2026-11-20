import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { mcpCommand, mcpUrl, mcpUrlWithToken } from '@/src/api';
import { useSession } from '@/src/session';
import { colors, gradient, radius, space, type as t, withAlpha } from '@/src/theme';
import { Button, IconButton, copyText, haptic, useToast } from '@/src/ui';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const WASH = [withAlpha(colors.accent, 0.18), withAlpha(colors.accent2, 0.04)] as const;

/** First 6 characters, then dots: enough to recognise the token, not enough to use it. */
export function maskToken(token: string): string {
  return `${token.slice(0, 6)}${'•'.repeat(10)}`;
}

/**
 * "Connect Claude (MCP)": the one standout card on Settings (gradient border, soft accent wash). The shown command
 * has its token masked until "Reveal"; both Copy buttons always copy the full, working value.
 */
export function ClaudeMcpCard() {
  const { token, mock } = useSession();
  const toast = useToast();
  const [revealed, setRevealed] = useState(false);

  const shownCommand = mcpCommand(token ? (revealed ? token : maskToken(token)) : null);

  const copy = async (text: string, done: string) => {
    const ok = await copyText(text);
    toast.show(ok ? done : "Couldn't copy to the clipboard.", ok ? 'success' : 'error');
  };

  return (
    <LinearGradient colors={gradient.colors} start={gradient.start} end={gradient.end} style={styles.border}>
      <View style={styles.inner}>
        <LinearGradient colors={WASH} start={gradient.start} end={gradient.end} style={StyleSheet.absoluteFill} />

        <View style={styles.head}>
          <LinearGradient colors={gradient.colors} start={gradient.start} end={gradient.end} style={styles.chip}>
            <Ionicons name="git-network-outline" size={20} color={colors.white} />
          </LinearGradient>
          <Text style={[t.h2, styles.title]} accessibilityRole="header">
            Connect Claude (MCP)
          </Text>
        </View>

        <Text style={t.dim}>
          Let Claude Desktop, Claude Code or claude.ai manage this workspace: read the dashboard, generate and publish
          posts, run autopilot.
        </Text>

        {mock ? (
          <View style={styles.banner} accessibilityRole="alert">
            <Ionicons name="cloud-offline-outline" size={16} color={colors.info} />
            <Text style={styles.bannerText}>
              Offline demo (mock data): MCP needs the live server, so Claude can&apos;t connect to this workspace.
            </Text>
          </View>
        ) : null}

        <View style={styles.block}>
          <Text style={t.label}>MCP URL</Text>
          <View style={styles.urlRow}>
            <Text style={[styles.mono, styles.urlText]} numberOfLines={1} selectable>
              {mcpUrl()}
            </Text>
            <IconButton
              icon="copy-outline"
              size={18}
              label="Copy MCP URL"
              onPress={() => void copy(mcpUrl(), 'MCP URL copied')}
            />
          </View>
        </View>

        <View style={styles.block}>
          <View style={styles.blockHead}>
            <Text style={t.label}>Terminal command</Text>
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
            <Text style={styles.codeText} selectable={revealed}>
              {shownCommand}
            </Text>
          </View>
        </View>

        <View style={styles.buttons}>
          <Button
            title="Copy command"
            icon="copy-outline"
            disabled={!token}
            onPress={() => void copy(mcpCommand(token), 'Command copied')}
            style={styles.buttonGrow}
          />
          <Button
            title="Copy URL with token"
            icon="link-outline"
            variant="secondary"
            disabled={!token}
            onPress={() => void copy(mcpUrlWithToken(token), 'URL with token copied')}
            style={styles.buttonGrow}
          />
        </View>
        <Text style={t.small}>
          claude.ai custom connectors can&apos;t send headers, so paste the URL with token there instead.
        </Text>

        <View style={styles.steps}>
          <Step n={1}>Run the command in your terminal.</Step>
          <Step n={2}>{'Ask Claude: “How is my social dashboard doing?”'}</Step>
        </View>

        <View style={styles.warn}>
          <Ionicons name="warning-outline" size={14} color={colors.warn} style={styles.warnIcon} />
          <Text style={[t.small, styles.warnText]}>
            The token grants full access to this guest workspace; don&apos;t share it.
          </Text>
        </View>
      </View>
    </LinearGradient>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}>
        <Text style={styles.stepNumText}>{n}</Text>
      </View>
      <Text style={[t.body, styles.stepText]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  border: { borderRadius: radius.md, padding: 1.5 },
  inner: {
    borderRadius: radius.md - 1.5,
    backgroundColor: colors.card,
    padding: space.lg,
    gap: space.md,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  chip: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: withAlpha(colors.info, 0.4),
    backgroundColor: withAlpha(colors.info, 0.1),
  },
  bannerText: { flex: 1, fontSize: 13.5, lineHeight: 19, color: colors.text },
  block: { gap: 6 },
  blockHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 24 },
  urlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.md,
    paddingRight: space.xs,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  mono: { ...t.mono, fontFamily: MONO },
  urlText: { flex: 1, minWidth: 0 },
  reveal: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28 },
  revealText: { fontSize: 13, fontWeight: '700', color: colors.accent },
  pressed: { opacity: 0.7 },
  code: {
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  codeText: { ...t.mono, fontFamily: MONO },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  buttonGrow: { flexGrow: 1, flexBasis: 200 },
  steps: { gap: space.sm, marginTop: space.xs },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    backgroundColor: withAlpha(colors.accent, 0.2),
  },
  stepNumText: { fontSize: 12.5, fontWeight: '800', color: colors.accent },
  stepText: { flex: 1 },
  warn: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  warnIcon: { marginTop: 2 },
  warnText: { flex: 1, color: colors.textMute },
});
