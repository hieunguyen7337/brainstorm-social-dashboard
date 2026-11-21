/**
 * Folds the events of a Claude run (`ClaudeEvent`, one parsed `claude -p --output-format stream-json` line each) into
 * display items for the assistant chat. Pure: no react-native import, so it runs under plain Node (events.test.ts).
 * Modelled on LocalBridge's renderer: text streams in from `content_block_delta` text deltas; the final assistant message's
 * text is used only when no deltas arrived; `tool_use` blocks become "Tool: name" lines.
 */
import type { ClaudeEvent } from '@/src/desktop/types';

export type ChatItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'text'; id: number; text: string }
  | { kind: 'tool'; id: number; text: string; input: string }
  | { kind: 'result'; id: number; text: string }
  | { kind: 'stderr'; id: number; text: string };

export interface ChatState {
  items: ChatItem[];
  /** The Claude conversation to continue (`--resume`), captured from any message's `session_id`. */
  sessionId: string | null;
  /** The run has ended (`done` arrived). */
  done: boolean;
  /** Id of the text item deltas are currently appended to, or null. */
  openText: number | null;
  /** Deltas arrived for the current assistant message, so its text blocks would repeat them. */
  gotDelta: boolean;
  nextId: number;
}

export const emptyChat = (): ChatState => ({ items: [], sessionId: null, done: false, openText: null, gotDelta: false, nextId: 1 });

/** "mcp__pulse__x" -> "Pulse: x", "mcp__pulse_desktop__x" -> "Desktop: x", anything else -> "Tool: name". */
export function toolLabel(name: string): string {
  const desktop = /^mcp__pulse_desktop__(.+)$/.exec(name);
  if (desktop) return `Desktop: ${desktop[1]}`;
  const pulse = /^mcp__pulse__(.+)$/.exec(name);
  if (pulse) return `Pulse: ${pulse[1]}`;
  return `Tool: ${name}`;
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

/** Adds the person's prompt, starting a new run (the conversation id is kept). */
export function addUser(state: ChatState, text: string): ChatState {
  return {
    ...state,
    items: [...state.items, { kind: 'user', id: state.nextId, text }],
    done: false,
    openText: null,
    gotDelta: false,
    nextId: state.nextId + 1,
  };
}

type NewItem = ChatItem extends infer I ? (I extends ChatItem ? Omit<I, 'id'> : never) : never;

function push(state: ChatState, item: NewItem): ChatState {
  return { ...state, items: [...state.items, { ...item, id: state.nextId } as ChatItem], nextId: state.nextId + 1 };
}

function foldJson(state: ChatState, data: unknown): ChatState {
  const msg = rec(data);
  if (!msg) return state;
  let s = state;
  if (typeof msg.session_id === 'string' && msg.session_id && msg.session_id !== s.sessionId) s = { ...s, sessionId: msg.session_id };

  if (msg.type === 'stream_event') {
    const e = rec(msg.event) ?? {};
    const delta = rec(e.delta);
    if (e.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      if (s.openText === null) {
        return { ...push(s, { kind: 'text', text: delta.text }), openText: s.nextId, gotDelta: true };
      }
      const id = s.openText;
      return { ...s, gotDelta: true, items: s.items.map((it) => (it.id === id && it.kind === 'text' ? { ...it, text: it.text + delta.text } : it)) };
    }
    if (e.type === 'content_block_stop' || e.type === 'message_stop') return { ...s, openText: null };
    return s;
  }

  if (msg.type === 'assistant') {
    s = { ...s, openText: null };
    const content = rec(msg.message)?.content;
    for (const raw of Array.isArray(content) ? content : []) {
      const b = rec(raw);
      if (!b) continue;
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        s = push(s, { kind: 'tool', text: toolLabel(b.name), input: JSON.stringify(b.input ?? {}, null, 2) });
      } else if (b.type === 'text' && !s.gotDelta && typeof b.text === 'string' && b.text) {
        s = push(s, { kind: 'text', text: b.text });
      }
    }
    return { ...s, gotDelta: false };
  }

  if (msg.type === 'result') {
    const cost = msg.total_cost_usd ?? msg.cost_usd;
    const secs = typeof msg.duration_ms === 'number' ? ` in ${(msg.duration_ms / 1000).toFixed(1)}s` : '';
    const price = typeof cost === 'number' ? `, $${cost.toFixed(4)}` : '';
    return push(s, { kind: 'result', text: `Done${msg.is_error ? ' with an error' : ''}${secs}${price}` });
  }
  return s;
}

/** Folds one event of the run into the chat. */
export function foldEvent(state: ChatState, ev: ClaudeEvent): ChatState {
  if (ev.type === 'json') return foldJson(state, ev.data);
  if (ev.type === 'stderr') return ev.line.trim() ? push(state, { kind: 'stderr', text: ev.line }) : state;
  const s = { ...state, done: true, openText: null, gotDelta: false };
  return ev.code === 0 || ev.code === null ? s : push(s, { kind: 'result', text: `Claude exited with code ${ev.code}` });
}
