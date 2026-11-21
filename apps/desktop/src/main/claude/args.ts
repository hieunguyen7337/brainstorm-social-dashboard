import type { ClaudeRunRequest } from '@/src/desktop/types';

export const MAX_PROMPT_LENGTH = 20_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SYSTEM_PROMPT = [
  'You help this person run their social media through Pulse.',
  'Use the pulse tools for drafts, trends, themes and the dashboard.',
  'Use the pulse_desktop tools to read their signed-in accounts and to publish.',
  'Publishing always shows the person a confirm dialog in Pulse, so call social_publish only when they asked to post.',
  'Never ask for passwords or other credentials.',
  'Keep answers short.',
].join(' ');

/** Throws on bad input; returns the cleaned request. */
export function validateRun(req: unknown): ClaudeRunRequest {
  if (!req || typeof req !== 'object') throw new Error('Invalid request');
  const { prompt, sessionId } = req as Record<string, unknown>;
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt must be a non-empty string');
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`prompt is longer than ${MAX_PROMPT_LENGTH} characters`);
  if (sessionId === undefined || sessionId === null || sessionId === '') return { prompt };
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('invalid sessionId');
  return { prompt, sessionId };
}

/**
 * argv for `claude` (docs/DESKTOP.md 4.5). The prompt goes after `--` so a prompt that starts with a dash is never read
 * as a flag. No token ever goes in argv: the MCP config file carries it.
 */
export function buildArgs(req: ClaudeRunRequest, mcpConfigPath: string): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (req.sessionId) args.push('--resume', req.sessionId);
  args.push(
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--tools', '',
    '--allowedTools', 'mcp__pulse', 'mcp__pulse_desktop',
    '--append-system-prompt', SYSTEM_PROMPT,
    '--', req.prompt,
  );
  return args;
}
