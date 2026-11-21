/** Pulse Desktop only: chat with Claude Code on this computer. The tab is hidden (`href: null`) everywhere else. */
import { useCallback, useEffect, useState } from 'react';
import { Text } from 'react-native';

import { AssistantPanel } from '@/src/components/assistant/AssistantPanel';
import { ClaudeStatusCard } from '@/src/components/assistant/ClaudeStatusCard';
import { getDesktop, type ClaudeState } from '@/src/desktop';
import { type as t } from '@/src/theme';
import { Screen, Skeleton } from '@/src/ui';

export default function AssistantScreen() {
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
