/**
 * The phone Assistant (Android, iOS): chat with Claude using the person's own Anthropic API key, straight from the phone
 * to Anthropic (never through Pulse's server). Tools read Pulse data through the normal api client; posting goes through
 * the confirm dialog. The web build uses `MobileAssistant.web.tsx` (nothing there), which keeps the SDK out of the bundle.
 */
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { ChatItemView } from '@/src/components/assistant/ChatItemView';
import { colors, space, type as t } from '@/src/theme';
import { Button, Card, Chip, Skeleton, TextField } from '@/src/ui';

import { useApiKeyStatus } from './keyStore';
import { modelOption } from './models';
import { useModel } from './modelStore';
import { PostProposalDialog } from './PostProposalDialog';
import { useAssistant } from './useAssistant';

const STARTERS = ["Draft an Instagram post about today's top trend", 'How is my dashboard doing?', 'What are my best posts?'];

function Chat({ modelId, hint }: { modelId: string; hint: string }) {
  const { chat, running, error, pending, send, stop, reset, answerProposal } = useAssistant(modelId);
  const [prompt, setPrompt] = useState('');
  const scroller = useRef<ScrollView>(null);

  const submit = (text: string) => {
    setPrompt('');
    void send(text);
  };

  return (
    <Card style={styles.card}>
      <Text style={t.small}>{`${modelOption(modelId).name} · key ${hint}`}</Text>
      <ScrollView
        ref={scroller}
        style={styles.log}
        nestedScrollEnabled
        contentContainerStyle={styles.logContent}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
      >
        {chat.items.length === 0 ? (
          <View style={styles.starters}>
            <Text style={t.dim}>Ask Claude to work on your Pulse workspace. Try:</Text>
            <View style={styles.chips}>
              {STARTERS.map((s) => (
                <Chip key={s} label={s} onPress={() => submit(s)} />
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
          <Button small title="Send" icon="send" disabled={!prompt.trim()} onPress={() => submit(prompt)} />
        )}
        <Button small variant="ghost" title="New chat" onPress={reset} disabled={chat.items.length === 0 && !running} />
      </View>
      {pending ? <PostProposalDialog key={pending.proposal.caption} proposal={pending.proposal} onDone={answerProposal} /> : null}
    </Card>
  );
}

export function MobileAssistant() {
  const key = useApiKeyStatus();
  const model = useModel();

  if (!key.ready) return <Skeleton height={120} />;
  if (!key.available) {
    return (
      <Card style={styles.card}>
        <Text style={t.h3}>Update the app</Text>
        <Text style={t.dim}>This version of Pulse can't store a Claude API key safely. Install the latest version, then add your key in Settings.</Text>
      </Card>
    );
  }
  if (!key.hint) {
    return (
      <Card style={styles.card}>
        <Text style={t.h3}>Add your Claude API key</Text>
        <Text style={t.dim}>
          The Assistant uses your own Anthropic API key. It stays on this phone and requests go straight from here to Anthropic, never
          through Pulse's servers.
        </Text>
        <Button title="Open Settings" icon="settings" onPress={() => router.navigate('/settings')} />
      </Card>
    );
  }
  return <Chat modelId={model} hint={key.hint} />;
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  log: { maxHeight: 420, minHeight: 200 },
  logContent: { gap: space.sm, paddingVertical: space.xs },
  starters: { gap: space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  error: { color: colors.danger },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
