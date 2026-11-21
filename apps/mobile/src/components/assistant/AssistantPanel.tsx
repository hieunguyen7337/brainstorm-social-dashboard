/**
 * Pulse Desktop: chat with Claude Code running on this computer (`window.pulseDesktop.claude`). Streams the run's events
 * (`events.ts`), keeps the conversation id for the next prompt, and can stop a run.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { getDesktop } from '@/src/desktop';
import { colors, space, type as t } from '@/src/theme';
import { Button, Card, Chip, TextField } from '@/src/ui';
import { ChatItemView } from './ChatItemView';
import { addUser, emptyChat, foldEvent } from './events';

const STARTERS = ["Draft an Instagram post about today's top trend", 'Read my Instagram numbers', 'How is my dashboard doing?'];

export function AssistantPanel() {
  const [chat, setChat] = useState(emptyChat);
  const [prompt, setPrompt] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsub = useRef<(() => void) | null>(null);
  const scroller = useRef<ScrollView>(null);
  const sessionId = useRef<string | null>(null);
  sessionId.current = chat.sessionId;

  useEffect(() => () => unsub.current?.(), []);

  const send = useCallback(async (text: string) => {
    const desktop = getDesktop();
    const trimmed = text.trim();
    if (!desktop || !trimmed) return;
    setError(null);
    setPrompt('');
    setChat((c) => addUser(c, trimmed));
    try {
      const { runId: id } = await desktop.claude.run({ prompt: trimmed, sessionId: sessionId.current ?? undefined });
      setRunId(id);
      unsub.current?.();
      const off = desktop.claude.onEvent(id, (ev) => {
        setChat((c) => foldEvent(c, ev));
        if (ev.type === 'done') {
          off();
          if (unsub.current === off) unsub.current = null;
          setRunId((cur) => (cur === id ? null : cur));
        }
      });
      unsub.current = off;
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't start Claude. Try again.");
    }
  }, []);

  const stop = () => {
    if (runId) void getDesktop()?.claude.stop(runId).catch(() => undefined);
  };

  const reset = () => {
    unsub.current?.();
    unsub.current = null;
    if (runId) void getDesktop()?.claude.stop(runId).catch(() => undefined);
    setRunId(null);
    setChat(emptyChat());
    setError(null);
  };

  const running = runId !== null;

  return (
    <Card style={styles.card}>
      <ScrollView
        ref={scroller}
        style={styles.log}
        contentContainerStyle={styles.logContent}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
      >
        {chat.items.length === 0 ? (
          <View style={styles.starters}>
            <Text style={t.dim}>Ask Claude to work on your Pulse workspace. Try:</Text>
            <View style={styles.chips}>
              {STARTERS.map((s) => (
                <Chip key={s} label={s} onPress={() => void send(s)} />
              ))}
            </View>
          </View>
        ) : (
          chat.items.map((item) => <ChatItemView key={item.id} item={item} />)
        )}
        {running ? <Text style={t.small}>Claude is working...</Text> : null}
      </ScrollView>
      {error ? (
        <Text style={[t.small, styles.error]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <TextField
        value={prompt}
        onChangeText={setPrompt}
        placeholder="Ask Claude..."
        multiline
        accessibilityLabel="Message to Claude"
        editable={!running}
      />
      <View style={styles.actions}>
        {running ? (
          <Button small variant="danger" title="Stop" icon="stop" onPress={stop} />
        ) : (
          <Button small title="Send" icon="send" disabled={!prompt.trim()} onPress={() => void send(prompt)} />
        )}
        <Button small variant="ghost" title="New conversation" onPress={reset} disabled={chat.items.length === 0 && !running} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  log: { maxHeight: 520, minHeight: 200 },
  logContent: { gap: space.sm, paddingVertical: space.xs },
  starters: { gap: space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  error: { color: colors.danger },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
