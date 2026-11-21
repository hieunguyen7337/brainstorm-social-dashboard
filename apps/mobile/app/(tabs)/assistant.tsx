/**
 * Pulse Desktop: chat with Claude Code on this computer. Android / iOS: chat with Claude using the person's own API key
 * (src/assistant). The tab is hidden (`href: null`) on plain web.
 */
import { useCallback, useEffect, useState } from 'react';
import { Text } from 'react-native';

import { AssistantPanel } from '@/src/components/assistant/AssistantPanel';
import { ClaudeStatusCard } from '@/src/components/assistant/ClaudeStatusCard';
import { MobileAssistant } from '@/src/assistant/MobileAssistant';
import { getDesktop, isDesktop, type ClaudeState } from '@/src/desktop';
import { type as t } from '@/src/theme';
import { Screen, Skeleton } from '@/src/ui';

export default function AssistantScreen() {
  if (!isDesktop()) {
    return (
      <Screen title="Assistant" subtitle="Claude with your own API key, working in your Pulse workspace.">
        <MobileAssistant />
      </Screen>
    );
  }
  return <DesktopAssistant />;
}

function DesktopAssistant() {
  const [claude, setClaude] = useState<ClaudeState | null>(null);
  const [failed, setFailed] = useState(false);

  const check = useCallback(() => {
    setFailed(false);
    getDesktop()
      ?.claude.status()
      .then(setClaude, () => setFailed(true));
  }, []);
  useEffect(check, [check]);

  return (
    <Screen title="Assistant" subtitle="Claude Code on this computer, working in your Pulse workspace.">
      {failed ? <Text style={[t.dim]}>{"Couldn't check Claude Code. Restart Pulse Desktop and try again."}</Text> : null}
      {!claude && !failed ? <Skeleton height={120} /> : null}
      {claude && claude.state !== 'ready' ? <ClaudeStatusCard state={claude} onState={setClaude} /> : null}
      {claude?.state === 'ready' ? <AssistantPanel /> : null}
    </Screen>
  );
}
