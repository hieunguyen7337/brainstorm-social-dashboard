import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, type RunningMcp } from '../src/main/mcp/server.ts';
import { createTools, type ToolDeps } from '../src/main/mcp/tools.ts';
import { createConfirmer } from '../src/main/mcp/confirm.ts';
import { buildIngestRequest } from '../src/main/mcp/ingest.ts';
import { DESKTOP_PUBLISH_PLATFORMS, DESKTOP_READ_PLATFORMS } from '../../mobile/src/desktop/types.ts';
import { base64Size, IG_MAX_BYTES } from '../../mobile/src/igPost/logic.ts';
import type { DeviceRead, PublishConfirmAnswer } from '../../mobile/src/desktop/types.ts';
import type { PostOutcome, PostRequest } from '../src/main/social/post.ts';

const SIGNED = { signedIn: true, lastReadAt: null };
const OUT = { signedIn: false, lastReadAt: null };

const sampleRead = (): DeviceRead => ({
  platform: 'instagram',
  detected_platform: 'instagram',
  handle: '@pulse.fan',
  followers: 1234.4,
  following: 10,
  posts_count: 40,
  views: 5000,
  engagements: 300,
  profile_views: null,
  period_days: 30,
  posts: [
    { content: ' Hello world ', views: 100, likes: 5, comments: 2, shares: null, posted_at: '2026-11-01' },
    { content: '', views: 1, likes: 1, comments: 1, shares: 1, posted_at: null },
    { content: 'no numbers', views: null, likes: null, comments: null, shares: null, posted_at: null },
  ],
  confidence: 'high',
  notes: null,
  ai_used: true,
  source: 'device',
});

interface Harness {
  deps: ToolDeps;
  calls: { post: PostRequest[]; confirm: unknown[]; fetch: Array<{ url: string; init: RequestInit }>; read: string[] };
  state: { signedIn: boolean; hasWindow: boolean; answer: PublishConfirmAnswer; read: () => Promise<unknown>; time: number };
}

function harness(): Harness {
  const calls: Harness['calls'] = { post: [], confirm: [], fetch: [], read: [] };
  const state: Harness['state'] = {
    signedIn: true,
    hasWindow: true,
    answer: { ok: true, caption: 'edited', imageBase64: 'AAAA', mediaType: 'image/jpeg' },
    read: async () => ({ ok: true, read: sampleRead() }),
    time: 1_000_000,
  };
  const deps: ToolDeps = {
    apiUrl: 'https://api.test',
    getToken: () => 'ws-token',
    hasWindow: () => state.hasWindow,
    status: async () =>
      Object.fromEntries(DESKTOP_READ_PLATFORMS.map((p) => [p, state.signedIn ? SIGNED : OUT])) as never,
    read: async (p) => {
      calls.read.push(p);
      return state.read() as never;
    },
    confirm: async (req) => {
      calls.confirm.push(req);
      return state.answer;
    },
    post: async (req): Promise<PostOutcome> => {
      calls.post.push(req);
      return { ok: true, code: 'ABC', url: 'https://www.instagram.com/p/ABC/' };
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.fetch.push({ url, init });
      return new Response(JSON.stringify({ matched: 1, created: 2, snapshots: 3, captured_at: 'now' }), { status: 200 });
    }) as never,
    now: () => state.time,
    readPlatforms: DESKTOP_READ_PLATFORMS,
    publishPlatforms: DESKTOP_PUBLISH_PLATFORMS,
  };
  return { deps, calls, state };
}

const textOf = (r: { content: Array<{ text: string }> }): string => r.content[0].text;

// ---- server auth + tools/list

const servers: RunningMcp[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

function rawRequest(
  url: string,
  headers: Record<string, string>,
  body = '{}',
  method = 'POST',
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('server: auth, host, origin and body checks', async () => {
  const mcp = await startMcpServer(createTools(harness().deps));
  servers.push(mcp);
  const port = new URL(mcp.url).port;
  const good = { authorization: `Bearer ${mcp.token}` };
  assert.match(mcp.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(mcp.token.length, 64);
  assert.equal((await rawRequest(mcp.url, {})).status, 401);
  assert.equal((await rawRequest(mcp.url, { authorization: 'Bearer nope' })).status, 401);
  assert.equal((await rawRequest(mcp.url, { ...good, host: 'evil.test' })).status, 403);
  assert.equal((await rawRequest(mcp.url, { ...good, host: `127.0.0.1:${Number(port) + 1}` })).status, 403);
  assert.equal((await rawRequest(mcp.url, { ...good, origin: 'http://evil.test' })).status, 403);
  assert.equal((await rawRequest(mcp.url, good, 'x'.repeat(1_100_000))).status, 413);
  assert.equal((await rawRequest(mcp.url, good, 'not json')).status, 400);
  assert.equal((await rawRequest(mcp.url, good, '{}', 'GET')).status, 405);
});

test('server: tools/list over the SDK client, and a call', async () => {
  const h = harness();
  const mcp = await startMcpServer(createTools(h.deps));
  servers.push(mcp);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } } }),
  );
  const list = await client.listTools();
  assert.deepEqual(list.tools.map((t) => t.name).sort(), ['social_publish', 'social_read_metrics', 'social_status']);
  const publish = list.tools.find((t) => t.name === 'social_publish');
  assert.match(publish?.description ?? '', /confirm/i);
  assert.match(publish?.description ?? '', /photo/i);
  const res = (await client.callTool({ name: 'social_status', arguments: {} })) as { content: Array<{ text: string }> };
  assert.equal(JSON.parse(textOf(res)).instagram.signedIn, true);
  await client.close();
});

// ---- tools

test('social_publish: cancel posts nothing', async () => {
  const h = harness();
  h.state.answer = { ok: false };
  const r = await createTools(h.deps).publish({ platform: 'instagram', caption: 'hi' });
  assert.equal(textOf(r), 'The person cancelled; nothing was posted.');
  assert.equal(h.calls.post.length, 0);
});

test('social_publish: ok posts once with the confirmed caption and marks the Pulse post', async () => {
  const h = harness();
  const r = await createTools(h.deps).publish({ platform: 'instagram', caption: 'hi', pulse_post_id: 'p_1' });
  assert.equal(h.calls.post.length, 1);
  assert.equal(h.calls.post[0].caption, 'edited');
  assert.equal(h.calls.confirm.length, 1);
  assert.equal((h.calls.confirm[0] as { pulsePostId: string }).pulsePostId, 'p_1');
  assert.equal(h.calls.fetch[0].url, 'https://api.test/api/posts/p_1/publish');
  assert.equal((h.calls.fetch[0].init.headers as Record<string, string>).Authorization, 'Bearer ws-token');
  const out = JSON.parse(textOf(r));
  assert.equal(out.posted, true);
  assert.equal(out.url, 'https://www.instagram.com/p/ABC/');
  assert.doesNotMatch(textOf(r), /AAAA|ws-token/);
});

test('social_publish: failure is reported, not retried', async () => {
  const h = harness();
  h.deps.post = async (req) => {
    h.calls.post.push(req);
    return { ok: false, stage: 'configure', text: 'Instagram refused the post. Nothing was posted.' };
  };
  const r = await createTools(h.deps).publish({ platform: 'instagram', caption: 'hi', pulse_post_id: 'p_1' });
  assert.equal(r.isError, true);
  assert.equal(h.calls.post.length, 1);
  assert.equal(h.calls.fetch.length, 0);
});

test('social_publish: refuses other platforms, long captions, no window; signed out gives the sign-in text', async () => {
  const h = harness();
  const tools = createTools(h.deps);
  assert.equal((await tools.publish({ platform: 'x', caption: 'hi' })).isError, true);
  assert.equal((await tools.publish({ platform: 'instagram', caption: 'x'.repeat(2201) })).isError, true);
  h.state.hasWindow = false;
  assert.match(textOf(await tools.publish({ platform: 'instagram', caption: 'hi' })), /nothing was posted/i);
  h.state.hasWindow = true;
  h.state.signedIn = false;
  assert.equal(
    textOf(await tools.publish({ platform: 'instagram', caption: 'hi' })),
    'Instagram needs the person to sign in again: ask them to press Connect with Instagram in Pulse.',
  );
  assert.equal(h.calls.confirm.length, 0);
  assert.equal(h.calls.post.length, 0);
});

test('social_publish: one at a time, five a day', async () => {
  const h = harness();
  let release: (a: PublishConfirmAnswer) => void = () => undefined;
  h.deps.confirm = () => new Promise((r) => (release = r));
  const tools = createTools(h.deps);
  const first = tools.publish({ platform: 'instagram', caption: 'a' });
  await new Promise((r) => setImmediate(r));
  assert.equal((await tools.publish({ platform: 'instagram', caption: 'b' })).isError, true);
  release({ ok: true, caption: 'a', imageBase64: 'AAAA', mediaType: 'image/jpeg' });
  await first;
  h.deps.confirm = async () => h.state.answer;
  for (let i = 0; i < 4; i++) await tools.publish({ platform: 'instagram', caption: 'c' });
  assert.equal(h.calls.post.length, 5);
  const sixth = await tools.publish({ platform: 'instagram', caption: 'd' });
  assert.equal(sixth.isError, true);
  assert.match(textOf(sixth), /5 posts a day/);
  h.state.time += 25 * 3_600_000;
  assert.equal((await tools.publish({ platform: 'instagram', caption: 'e' })).isError, undefined);
});

test('confirmer: timeout is a cancel, respond validates, no window is a cancel', async () => {
  const sent: Array<{ id: string }> = [];
  const c = createConfirmer({
    send: (r) => (sent.push(r), true),
    maxBytes: IG_MAX_BYTES,
    base64Size,
    timeoutMs: 20,
    newId: () => 'id1',
  });
  const base = { platform: 'instagram' as const, handle: null, caption: 'hi', pulsePostId: null };
  assert.deepEqual(await c.ask(base), { ok: false });
  assert.equal(c.pending(), 0);

  // A malformed answer (the dialog has already closed) is a cancel, not a 10-minute wait.
  for (const bad of [
    { ok: true, caption: 'x', mediaType: 'image/gif', imageBase64: 'AAAA' },
    { ok: true, caption: 'x'.repeat(2201), mediaType: 'image/png', imageBase64: 'AAAA' },
    { ok: true, caption: 'x', mediaType: 'image/png', imageBase64: 'A'.repeat(IG_MAX_BYTES * 2) },
  ]) {
    const pending = c.ask(base);
    c.respond('other', { ok: false });
    assert.equal(c.pending(), 1);
    c.respond('id1', bad);
    assert.deepEqual(await pending, { ok: false });
  }

  const p = c.ask(base);
  c.respond('id1', { ok: true, caption: 'ok', mediaType: 'image/png', imageBase64: 'AAAA', extra: 1 });
  assert.deepEqual(await p, { ok: true, caption: 'ok', mediaType: 'image/png', imageBase64: 'AAAA' });

  const none = createConfirmer({ send: () => false, maxBytes: 1, base64Size });
  assert.deepEqual(await none.ask(base), { ok: false });
});

test('social_read_metrics: ingest body from a DeviceRead, saved with the bearer', async () => {
  const body = buildIngestRequest(sampleRead());
  assert.deepEqual(body, {
    platform: 'instagram',
    source: 'device',
    handle: 'pulse.fan',
    period_days: 30,
    account: { followers: 1234, views: 5000, engagements: 300 },
    posts: [{ content: 'Hello world', posted_at: '2026-11-01', views: 100, engagements: 7 }],
  });
  const h = harness();
  const r = await createTools(h.deps).readMetrics({ platform: 'instagram' });
  assert.equal(h.calls.fetch[0].url, 'https://api.test/api/metrics/ingest');
  assert.deepEqual(JSON.parse(h.calls.fetch[0].init.body as string), body);
  const out = JSON.parse(textOf(r));
  assert.equal(out.saved, true);
  assert.equal(out.numbers.followers, 1234.4);
});

test('social_read_metrics: signed out, no token, unknown platform, rate limit', async () => {
  const h = harness();
  const tools = createTools(h.deps);
  h.state.read = async () => ({ ok: false, reason: 'signed_out' });
  assert.equal(
    textOf(await tools.readMetrics({ platform: 'linkedin' })),
    'LinkedIn needs the person to sign in again: ask them to press Connect with LinkedIn in Pulse.',
  );
  assert.equal((await tools.readMetrics({ platform: 'nope' })).isError, true);

  h.state.read = async () => ({ ok: true, read: sampleRead() });
  await tools.readMetrics({ platform: 'instagram' });
  h.state.time += 5 * 60_000;
  const again = await tools.readMetrics({ platform: 'instagram' });
  assert.match(textOf(again), /less than 10 minutes ago/);
  assert.equal(h.calls.read.filter((p) => p === 'instagram').length, 1);
  h.state.time += 6 * 60_000;
  await tools.readMetrics({ platform: 'instagram' });
  assert.equal(h.calls.read.filter((p) => p === 'instagram').length, 2);

  h.deps.getToken = () => null;
  const none = await createTools(h.deps).readMetrics({ platform: 'instagram' });
  assert.equal(textOf(none), 'Open Pulse and finish setup first.');
  assert.equal(none.isError, true);
});
