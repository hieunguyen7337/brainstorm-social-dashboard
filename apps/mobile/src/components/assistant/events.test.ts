/** Unit tests for src/components/assistant/events.ts: `npx jest --ci src/components/assistant`. */
import { addUser, emptyChat, foldEvent, toolLabel, type ChatState } from './events';
import type { ClaudeEvent } from '@/src/desktop/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (v: unknown) => any;

const json = (data: unknown): ClaudeEvent => ({ type: 'json', data });
const delta = (text: string): ClaudeEvent =>
  json({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const run = (events: ClaudeEvent[], from: ChatState = emptyChat()): ChatState => events.reduce(foldEvent, from);

describe('toolLabel', () => {
  it('names Pulse and Desktop MCP tools', () => {
    expect(toolLabel('mcp__pulse__list_trends')).toBe('Pulse: list_trends');
    expect(toolLabel('mcp__pulse_desktop__social_read')).toBe('Desktop: social_read');
    expect(toolLabel('Bash')).toBe('Tool: Bash');
  });
});

describe('foldEvent', () => {
  it('joins text deltas into one item and captures the session id', () => {
    const s = run([delta('Hel'), delta('lo')]);
    expect(s.items).toEqual([{ kind: 'text', id: 1, text: 'Hello' }]);
    expect(s.sessionId).toBe('s1');
  });

  it('starts a new text item after a block stops', () => {
    const stop = json({ type: 'stream_event', event: { type: 'content_block_stop' } });
    expect(run([delta('a'), stop, delta('b')]).items.map((i) => i.text)).toEqual(['a', 'b']);
  });

  it('uses the assistant text only when no deltas arrived', () => {
    const msg = json({ type: 'assistant', session_id: 's2', message: { content: [{ type: 'text', text: 'Full answer' }] } });
    expect(run([msg]).items.map((i) => i.text)).toEqual(['Full answer']);
    expect(run([delta('Full answer'), msg]).items.map((i) => i.text)).toEqual(['Full answer']);
  });

  it('shows tool_use blocks with friendly names', () => {
    const msg = json({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'mcp__pulse__get_dashboard', input: { a: 1 } }] },
    });
    const s = run([msg]);
    expect(s.items[0]).toMatchObject({ kind: 'tool', text: 'Pulse: get_dashboard' });
  });

  it('adds the result line, stderr lines and the exit code', () => {
    const s = run([
      json({ type: 'result', is_error: false, total_cost_usd: 0.0123, duration_ms: 2500 }),
      { type: 'stderr', line: 'warning x' },
      { type: 'done', code: 1 },
    ]);
    expect(s.items.map((i) => [i.kind, i.text])).toEqual([
      ['result', 'Done in 2.5s, $0.0123'],
      ['stderr', 'warning x'],
      ['result', 'Claude exited with code 1'],
    ]);
    expect(s.done).toBe(true);
  });

  it('keeps the session id across a new prompt and ignores junk', () => {
    const s = addUser(run([delta('hi'), { type: 'done', code: 0 }]), 'next');
    expect(s.sessionId).toBe('s1');
    expect(s.done).toBe(false);
    expect(run([json(null), json('x'), { type: 'stderr', line: '  ' }], s).items.length).toBe(s.items.length);
  });
});
