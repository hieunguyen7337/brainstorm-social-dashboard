/** Web stub of `client.ts`: the Assistant is native only (no secure place for a key on the web). Never called. */
import type { AgentClient } from './agent';
import type { Failure } from './errors';

export type KeyTest = { ok: true } | { ok: false; failure: Failure };

export function createAgentClient(_apiKey: string): AgentClient {
  throw new Error('The Assistant needs the Pulse phone app.');
}

export async function testApiKey(_apiKey: string, _model: string): Promise<KeyTest> {
  return { ok: false, failure: { kind: 'unknown', message: 'The Assistant needs the Pulse phone app.' } };
}
