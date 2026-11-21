/**
 * Pulse Desktop: what to do about Claude Code (docs/DESKTOP.md 4.5). One card per non-ready `ClaudeState`, each with the
 * command to copy and "Check again".
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getDesktop, type ClaudeState } from '@/src/desktop';
import { colors, radius, space, type as t } from '@/src/theme';
import { Button, Card, copyText } from '@/src/ui';

interface Props {
  state: ClaudeState;
  /** Called with the new state after "Check again" or "Choose the claude program". */
  onState: (next: ClaudeState) => void;
}

function CopyLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Copy ${command}`}
      onPress={() => void copyText(command).then((ok) => setCopied(ok))}
      style={styles.command}
    >
      <Text style={[t.mono, styles.commandText]} selectable>
        {command}
      </Text>
      <Text style={t.small}>{copied ? 'Copied' : 'Copy'}</Text>
    </Pressable>
  );
}

export function ClaudeStatusCard({ state, onState }: Props) {
  const [busy, setBusy] = useState(false);
  if (state.state === 'ready') return null;

  const ask = async (fn: () => Promise<ClaudeState>) => {
    setBusy(true);
    try {
      onState(await fn());
    } catch {
      // keep the current card; the person can try again
    } finally {
      setBusy(false);
    }
  };
  const claude = getDesktop()?.claude;
  if (!claude) return null;

  let title: string;
  let body: string;
  let command: string;
  if (state.state === 'not_found') {
    title = 'Install Claude Code';
    body = 'Pulse uses Claude Code on this computer to run the assistant. Install it, then check again.';
    command = 'npm install -g @anthropic-ai/claude-code';
  } else if (state.state === 'signed_out') {
    title = 'Sign in to Claude';
    body = 'Claude Code is installed (version ' + state.version + ') but not signed in. Run this in a terminal, then check again.';
    command = 'claude auth login';
  } else {
    title = 'Update Claude Code';
    body = `Claude Code ${state.version} is too old; Pulse needs ${state.minimum} or newer. Update it, then check again.`;
    command = 'npm install -g @anthropic-ai/claude-code@latest';
  }

  return (
    <Card tone="raised" style={styles.card}>
      <View style={styles.head} accessibilityRole="alert">
        <Text style={t.h3}>{title}</Text>
        <Text style={t.dim}>{body}</Text>
      </View>
      <CopyLine command={command} />
      <View style={styles.actions}>
        <Button small title="Check again" icon="refresh" loading={busy} onPress={() => void ask(() => claude.status())} />
        {state.state === 'not_found' ? (
          <Button
            small
            variant="secondary"
            title="Choose the claude program"
            icon="folder-open-outline"
            disabled={busy}
            onPress={() => void ask(() => claude.chooseBinary())}
          />
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  head: { gap: space.xs },
  command: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  commandText: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
