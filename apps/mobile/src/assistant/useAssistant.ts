/**
 * Session state of the phone Assistant: the chat the person sees, the API-format history Claude gets, the running turn
 * (Stop aborts it) and the post proposal waiting for the confirm dialog. Everything is in memory: "New chat" forgets it.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/src/api';
import { addItem, addUser, emptyChat, type ChatState } from '@/src/components/assistant/events';

import { runTurn, type AgentEvent } from './agent';
import { createAgentClient } from './client';
import { readApiKey } from './keyStore';
import type { PostOutcome, PostProposal } from './tools';

export interface PendingProposal {
  proposal: PostProposal;
  answer: (outcome: PostOutcome) => void;
}

const fold = (c: ChatState, ev: AgentEvent): ChatState => {
  switch (ev.type) {
    case 'text':
      return addItem(c, { kind: 'text', text: ev.text });
    case 'tool':
      return addItem(c, { kind: 'tool', text: `Pulse: ${ev.name}`, input: JSON.stringify(ev.input ?? {}, null, 2) });
    case 'tool_error':
      return addItem(c, { kind: 'stderr', text: `${ev.name}: ${ev.message}` });
    default:
      return addItem(c, { kind: 'result', text: ev.text });
  }
};

export function useAssistant(model: string) {
  const [chat, setChat] = useState(emptyChat);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingProposal | null>(null);
  const history = useRef<Anthropic.Beta.BetaMessageParam[]>([]);
  const abort = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingProposal | null>(null);

  const clearPending = useCallback((outcome: PostOutcome) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    p?.answer(outcome);
  }, []);

  const proposePost = useCallback(
    (proposal: PostProposal, signal?: AbortSignal) =>
      new Promise<PostOutcome>((resolve) => {
        const p: PendingProposal = { proposal, answer: resolve };
        pendingRef.current = p;
        setPending(p);
        signal?.addEventListener('abort', () => {
          if (pendingRef.current === p) clearPending({ status: 'cancelled' });
        });
      }),
    [clearPending],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || abort.current) return;
      setError(null);
      const key = await readApiKey();
      if (!key) {
        setError('No Claude API key saved. Add one in Settings > Claude API key.');
        return;
      }
      const ctrl = new AbortController();
      abort.current = ctrl;
      setRunning(true);
      setChat((c) => addUser(c, trimmed));
      const outcome = await runTurn(history.current, trimmed, {
        client: createAgentClient(key),
        model,
        signal: ctrl.signal,
        tools: { api, proposePost, signal: ctrl.signal },
        onEvent: (ev) => setChat((c) => fold(c, ev)),
      });
      if (outcome.kind === 'error') setError(outcome.failure.message);
      else if (outcome.kind === 'aborted') setChat((c) => addItem(c, { kind: 'result', text: 'Stopped.' }));
      if (abort.current === ctrl) abort.current = null;
      setRunning(false);
    },
    [model, proposePost],
  );

  const stop = useCallback(() => {
    abort.current?.abort();
    clearPending({ status: 'cancelled' });
  }, [clearPending]);

  const reset = useCallback(() => {
    stop();
    history.current = [];
    setChat(emptyChat());
    setError(null);
  }, [stop]);

  // Leaving the screen ends the turn and drops the history.
  useEffect(() => () => abort.current?.abort(), []);

  return { chat, running, error, pending, send, stop, reset, answerProposal: clearPending };
}
