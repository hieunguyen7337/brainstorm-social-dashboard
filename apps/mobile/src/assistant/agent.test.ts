import Anthropic from '@anthropic-ai/sdk';

import { MAX_ITERATIONS, runTurn, type AgentClient, type AgentEvent } from './agent';
import type { ToolDeps } from './tools';

type Reply = Awaited<ReturnType<AgentClient['create']>>;

const reply = (stop_reason: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  ({ stop_reason, content, stop_details: null, ...extra }) as unknown as Reply;
const text = (t: string) => ({ type: 'text', text: t });
const use = (id: string, name = 'list_trends', input: unknown = {}) => ({ type: 'tool_use', id, name, input });

function setup(replies: (Reply | Error)[], toolsOver: Partial<ToolDeps> = {}) {
  const calls: Record<string, unknown>[] = [];
  const client: AgentClient = {
    create: jest.fn(async (params) => {
      calls.push(JSON.parse(JSON.stringify(params)));
      const next = replies.shift();
      if (!next) throw new Error('no more replies');
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const events: AgentEvent[] = [];
  const api = { listTrends: jest.fn(async () => []) };
  const tools = { api, proposePost: jest.fn(), ...toolsOver } as unknown as ToolDeps;
  return { client, calls, events, tools, onEvent: (e: AgentEvent) => events.push(e) };
}

describe('runTurn', () => {
  it('runs tool_use -> tool_result -> end_turn and keeps the full content in history', async () => {
    const s = setup([reply('tool_use', [text('Looking'), use('t1')]), reply('end_turn', [text('Done')])]);
    const history: any[] = [];
    const out = await runTurn(history, 'hi', { client: s.client, tools: s.tools, onEvent: s.onEvent });
    expect(out).toEqual({ kind: 'done' });
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history[1].content[1]).toMatchObject({ type: 'tool_use', id: 't1' });
    expect(history[2].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '[]' }]);
    expect(s.events.map((e) => e.type)).toEqual(['text', 'tool', 'text']);
  });

  it('sends model options, auto tool choice, strict tools and the fallback beta for Opus', async () => {
    const s = setup([reply('end_turn', [text('x')])]);
    await runTurn([], 'hi', { client: s.client, tools: s.tools, onEvent: s.onEvent });
    const p = s.calls[0] as any;
    expect(p).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
    expect(p).not.toHaveProperty('tool_choice');
    expect(p.tools.every((t: any) => t.strict === true)).toBe(true);
  });

  it('uses the picked model, and no fallbacks on Haiku', async () => {
    const s = setup([reply('end_turn', [text('x')])]);
    await runTurn([], 'hi', { client: s.client, tools: s.tools, onEvent: s.onEvent, model: 'claude-haiku-5-5' });
    expect(s.calls[0]).toMatchObject({ model: 'claude-haiku-5-5' });
    expect(s.calls[0]).not.toHaveProperty('fallbacks');
  });

  it('turns a failing tool into an is_error tool_result and goes on', async () => {
    const s = setup([reply('tool_use', [use('t1', 'create_post', { platform: 'x' })]), reply('end_turn', [text('ok')])]);
    const history: any[] = [];
    await runTurn(history, 'hi', { client: s.client, tools: s.tools, onEvent: s.onEvent });
    expect(history[2].content[0]).toMatchObject({ tool_use_id: 't1', is_error: true });
    expect(s.events.some((e) => e.type === 'tool_error')).toBe(true);
  });

  it('continues after pause_turn', async () => {
    const s = setup([reply('pause_turn', [text('part')]), reply('end_turn', [text('rest')])]);
    const out = await runTurn([], 'hi', { client: s.client, tools: s.tools, onEvent: s.onEvent });
    expect(out.kind).toBe('done');
    expect(s.client.create).toHaveBeenCalledTimes(2);
  });

  it('stops at the iteration cap with a valid history', async () => {
    const s = setup(Array.from({ length: MAX_ITERATIONS + 2 }, (_, i) => reply('tool_use', [use(`t${i}`)])));
    const history: any[] = [];
    const out = await runTurn(history, 'hi', { client: s.client, tools: s.tools, onEvent: s.onEvent });
    expect(out.kind).toBe('max_iterations');
    expect(s.client.create).toHaveBeenCalledTimes(MAX_ITERATIONS);
    expect(history[history.length - 1].role).toBe('user');
    expect(history[history.length - 1].content[0].type).toBe('tool_result');
    expect(s.events[s.events.length - 1].type).toBe('notice');
  });

  it('rolls the turn back on a refusal and shows the explanation', async () => {
    const s = setup([reply('refusal', [text('no')], { stop_details: { type: 'refusal', category: null, explanation: 'Not allowed' } })]);
    const history: any[] = [{ role: 'user', content: 'before' }, { role: 'assistant', content: [text('ok')] }];
    const out = await runTurn(history, 'bad', { client: s.client, tools: s.tools, onEvent: s.onEvent });
    expect(out).toEqual({ kind: 'refusal', explanation: 'Not allowed' });
    expect(history).toHaveLength(2);
    expect(s.events.find((e) => e.type === 'notice')).toMatchObject({ text: expect.stringContaining('Not allowed') });
  });

  it('on max_tokens keeps text but never a cut-off tool_use', async () => {
    const withText = setup([reply('max_tokens', [text('long')])]);
    const h1: any[] = [];
    expect((await runTurn(h1, 'hi', { client: withText.client, tools: withText.tools, onEvent: withText.onEvent })).kind).toBe('max_tokens');
    expect(h1.map((m) => m.role)).toEqual(['user', 'assistant']);

    const withTool = setup([reply('max_tokens', [use('t1')])]);
    const h2: any[] = [];
    await runTurn(h2, 'hi', { client: withTool.client, tools: withTool.tools, onEvent: withTool.onEvent });
    expect(h2.map((m) => m.role)).toEqual(['user']);
    expect(withTool.tools.api.listTrends).not.toHaveBeenCalled();
  });

  it('maps SDK errors to a friendly failure and drops the failed message', async () => {
    const err = new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers());
    const s = setup([err]);
    const history: any[] = [];
    const out = await runTurn(history, 'hi', { client: s.client, tools: s.tools, onEvent: s.onEvent });
    expect(out).toMatchObject({ kind: 'error', failure: { kind: 'invalid_key' } });
    expect(history).toEqual([]);
  });

  it('keeps finished exchanges when a later step fails', async () => {
    const s = setup([reply('tool_use', [use('t1')]), new Anthropic.APIConnectionError({ message: 'offline' })]);
    const history: any[] = [];
    const out = await runTurn(history, 'hi', { client: s.client, tools: s.tools, onEvent: s.onEvent });
    expect(out).toMatchObject({ kind: 'error', failure: { kind: 'network' } });
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('Stop during a tool leaves no dangling tool_use', async () => {
    const ctrl = new AbortController();
    const s = setup([reply('tool_use', [use('t1')])], {
      api: { listTrends: jest.fn(async () => (ctrl.abort(), [])) } as unknown as ToolDeps['api'],
    });
    const history: any[] = [];
    const out = await runTurn(history, 'hi', { client: s.client, tools: s.tools, signal: ctrl.signal, onEvent: s.onEvent });
    expect(out).toEqual({ kind: 'aborted' });
    expect(history).toEqual([]);
  });

  it('an aborted request is reported as aborted, not an error', async () => {
    const ctrl = new AbortController();
    const s = setup([new Anthropic.APIUserAbortError()]);
    ctrl.abort();
    const out = await runTurn([], 'hi', { client: s.client, tools: s.tools, signal: ctrl.signal, onEvent: s.onEvent });
    expect(out).toEqual({ kind: 'aborted' });
    expect(s.client.create).not.toHaveBeenCalled();
  });
});
