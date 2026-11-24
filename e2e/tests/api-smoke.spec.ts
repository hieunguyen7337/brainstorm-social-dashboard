import { test, expect, SHARED_TOKEN } from './fixtures';

test('health endpoint', async ({ request }) => {
  const r = await request.get('/api/health');
  expect(r.ok()).toBeTruthy();
  expect((await r.json()).ok).toBe(true);
});

test('/mcp tools/list returns 10 tools', async ({ request }) => {
  let token = SHARED_TOKEN;
  if (!token) {
    const ws = await request.post('/api/workspaces', { data: {} });
    expect(ws.ok()).toBeTruthy();
    token = (await ws.json()).token;
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const init = await request.post('/mcp', {
    headers,
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
    },
  });
  expect(init.ok()).toBeTruthy();
  const sid = init.headers()['mcp-session-id'];
  const h2: Record<string, string> = sid ? { ...headers, 'mcp-session-id': sid } : headers;
  await request.post('/mcp', { headers: h2, data: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  const r = await request.post('/mcp', { headers: h2, data: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  expect(r.ok()).toBeTruthy();
  const text = await r.text();
  // plain JSON or SSE ("data: {...}")
  const line = text.startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
  const body = JSON.parse(line);
  expect(body.result.tools).toHaveLength(10);
});
