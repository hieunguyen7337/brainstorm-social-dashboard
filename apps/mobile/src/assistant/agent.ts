/**
 * The Assistant's agent loop: one person message -> Claude -> tool calls on the phone -> Claude -> ... -> an answer.
 *
 * A manual loop on the non-streaming Messages API, not the SDK's tool runner: the runner is beta, and this loop needs
 * things it does not give for free: a person-in-the-loop tool (the post dialog can take minutes and must end cleanly on
 * Stop), a hard iteration cap, per-step events for the chat, and exact control of what stays in the history after a
 * failure. Non-streaming because React Native's fetch does not expose a readable body stream, so SSE would not work.
 *
 * Pure: no react-native import. The client is injected (`AgentClient`), so tests drive it with a fake (agent.test.ts).
 * The requests go from the phone straight to Anthropic with the person's own key; Pulse's server is never in the path.
 */
import type Anthropic from '@anthropic-ai/sdk';

import { describeFailure, type Failure } from './errors';
import { modelRequestOptions } from './models';
import { runTool, TOOLS, type ToolDeps } from './tools';

type Msg = Anthropic.Beta.BetaMessageParam;
type Reply = Anthropic.Beta.BetaMessage;
type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;

export const MAX_TOKENS = 16000;
/** Model calls per person message (each tool round trip is one). Stops a tool loop that will not end. */
export const MAX_ITERATIONS = 8;

export const SYSTEM_PROMPT = `You are the assistant inside Pulse, a social media manager for small brands. You work in the person's own Pulse workspace (LinkedIn and Instagram), from their phone.

You can read the dashboard, trends and posts, save drafts with create_post, and propose an Instagram post with propose_instagram_post. Pulse cannot create images and you cannot pick the photo: the person chooses it themselves.

Posting always goes through the person. propose_instagram_post opens a dialog with your caption (they can edit it) and a photo picker, and nothing is posted unless they press the button. Never say a post is live until the tool result says so; "handed_to_instagram" means they finish it in the Instagram share sheet.

Be brief and concrete. Use the tools to look at real numbers before giving advice, and say so when a number is missing instead of guessing. Write captions in the brand's own voice, without filler.`;

/** The one call the loop makes on the SDK (`client.beta.messages.create`, or a fake in tests). */
export interface AgentClient {
  create(params: Params, options?: { signal?: AbortSignal }): Promise<Reply>;
}

/** What the chat shows as the turn runs. */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'tool_error'; name: string; message: string }
  | { type: 'notice'; text: string };

export type TurnOutcome =
  | { kind: 'done' }
  | { kind: 'max_iterations' }
  | { kind: 'max_tokens' }
  | { kind: 'context_full' }
  | { kind: 'refusal'; explanation: string | null }
  | { kind: 'aborted' }
  | { kind: 'error'; failure: Failure };

export interface AgentDeps {
  client: AgentClient;
  tools: ToolDeps;
  /** The model the person picked (`models.ts`); unknown values fall back to the default. */
  model?: string;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

const isText = (b: Anthropic.Beta.BetaContentBlock): b is Anthropic.Beta.BetaTextBlock => b.type === 'text';
const isToolUse = (b: Anthropic.Beta.BetaContentBlock): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use';

/**
 * Runs one person message to the end of Claude's answer. `history` is the whole conversation so far (API format) and is
 * extended in place with `response.content` of every step, so thinking blocks and tool_use ids stay intact. After a
 * failure it only ever holds complete exchanges (no tool_use without its tool_result), so the next message can go on.
 * Never throws.
 */
export async function runTurn(history: Msg[], userText: string, deps: AgentDeps): Promise<TurnOutcome> {
  const { client, signal, onEvent } = deps;
  /** Length of the history at the last point where it is valid to send. */
  let committed = history.length;
  history.push({ role: 'user', content: userText });
  const abandon = (): void => {
    history.length = committed;
  };

  try {
    for (let step = 0; step < MAX_ITERATIONS; step++) {
      if (signal?.aborted) {
        abandon();
        return { kind: 'aborted' };
      }
      const reply = await client.create(
        {
          max_tokens: MAX_TOKENS,
          // Adaptive thinking, effort medium, and server-side refusal fallbacks where the model has them.
          ...modelRequestOptions(deps.model),
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          // Auto tool choice only: forcing a tool is rejected on this model.
          messages: [...history],
        },
        { signal },
      );

      for (const block of reply.content) if (isText(block) && block.text.trim()) onEvent({ type: 'text', text: block.text });
      const calls = reply.content.filter(isToolUse);

      switch (reply.stop_reason) {
        case 'refusal': {
          abandon();
          const explanation = reply.stop_details?.explanation ?? null;
          onEvent({ type: 'notice', text: explanation ? `Claude declined: ${explanation}` : 'Claude declined to help with that.' });
          return { kind: 'refusal', explanation };
        }
        case 'model_context_window_exceeded':
          abandon();
          onEvent({ type: 'notice', text: 'This chat is too long for Claude to continue. Start a new chat.' });
          return { kind: 'context_full' };
        case 'max_tokens':
          // A tool_use cut off by the limit has partial input: never run it, never keep it.
          if (calls.length === 0) history.push({ role: 'assistant', content: reply.content });
          committed = history.length;
          onEvent({ type: 'notice', text: 'Claude ran out of room for that answer. Ask for a shorter one.' });
          return { kind: 'max_tokens' };
        case 'pause_turn':
          // Claude paused a long turn: send it back unchanged and it carries on.
          history.push({ role: 'assistant', content: reply.content });
          continue;
        case 'tool_use': {
          if (calls.length === 0) break; // nothing to run: treat as finished
          history.push({ role: 'assistant', content: reply.content });
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const call of calls) {
            if (signal?.aborted) {
              abandon();
              return { kind: 'aborted' };
            }
            onEvent({ type: 'tool', name: call.name, input: call.input });
            const out = await runTool(call.name, call.input, deps.tools);
            if (out.isError) onEvent({ type: 'tool_error', name: call.name, message: out.content });
            results.push({ type: 'tool_result', tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : null) });
          }
          if (signal?.aborted) {
            abandon();
            return { kind: 'aborted' };
          }
          history.push({ role: 'user', content: results });
          committed = history.length;
          continue;
        }
        default:
          break; // end_turn, stop_sequence
      }

      history.push({ role: 'assistant', content: reply.content });
      committed = history.length;
      return { kind: 'done' };
    }
  } catch (e) {
    abandon();
    if (signal?.aborted) return { kind: 'aborted' };
    const failure = describeFailure(e);
    return failure.kind === 'aborted' ? { kind: 'aborted' } : { kind: 'error', failure };
  }

  // Cap reached: the history ends with the last tool_results, which is a valid place to go on from.
  onEvent({ type: 'notice', text: `Stopped after ${MAX_ITERATIONS} steps. Send another message to continue.` });
  return { kind: 'max_iterations' };
}
