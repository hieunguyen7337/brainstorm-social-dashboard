/**
 * The loopback MCP server (streamable HTTP, stateless): 127.0.0.1, random port, per-launch bearer token. Wrong or
 * missing bearer 401, wrong Host or any Origin 403, body over 1 MB 413. A fresh MCP server + transport per request.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import crypto from 'node:crypto';
import http from 'node:http';
import { platformArg, publishArgs, TOOL_DESCRIPTIONS, type Tools } from './tools.ts';

export const MAX_BODY_BYTES = 1_000_000;
export const MCP_PATH = '/mcp';

export function buildMcpServer(tools: Tools): McpServer {
  const server = new McpServer({ name: 'pulse_desktop', version: '0.1.0' });
  server.tool('social_status', TOOL_DESCRIPTIONS.social_status, () => tools.socialStatus());
  server.tool('social_read_metrics', TOOL_DESCRIPTIONS.social_read_metrics, { platform: platformArg }, (a) =>
    tools.readMetrics(a),
  );
  server.tool('social_publish', TOOL_DESCRIPTIONS.social_publish, publishArgs, (a) => tools.publish(a));
  return server;
}

const sha = (s: string): Buffer => crypto.createHash('sha256').update(s).digest();

export interface RunningMcp {
  url: string;
  token: string;
  close(): Promise<void>;
}

function reply(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * The body, or null when it is over MAX_BODY_BYTES. Always resolves only once the request has been read to the end:
 * answering (413) while the client is still sending makes the socket close with unread data, and the client then sees
 * a reset (EPIPE/ECONNRESET) instead of the response.
 */
function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) chunks.length = 0; // keep draining without storing
      else chunks.push(c);
    });
    req.on('end', () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

export async function startMcpServer(tools: Tools, token: string = crypto.randomBytes(32).toString('hex')): Promise<RunningMcp> {
  const want = sha(`Bearer ${token}`);
  let port = 0;
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => reply(res, 500, 'Internal error'));
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return reply(res, 403, 'Forbidden');
    if (req.headers.origin !== undefined) return reply(res, 403, 'Forbidden');
    if (!crypto.timingSafeEqual(sha(req.headers.authorization ?? ''), want)) return reply(res, 401, 'Unauthorized');
    if (new URL(req.url ?? '/', 'http://x').pathname !== MCP_PATH) return reply(res, 404, 'Not found');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reply(res, 405, 'Method not allowed');
    }
    // An oversized body is drained (only an authenticated caller gets here) before the 413, see readBody.
    const raw = await readBody(req);
    if (raw === null) {
      res.setHeader('Connection', 'close');
      return reply(res, 413, 'Body too large');
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply(res, 400, 'Invalid JSON');
    }
    const mcp = buildMcpServer(tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
