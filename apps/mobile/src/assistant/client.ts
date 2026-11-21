/**
 * The Anthropic SDK client, built per request batch from the person's own key (native only: `client.web.ts` is the web
 * stub, so the SDK never reaches the web bundle).
 *
 * `dangerouslyAllowBrowser` is NOT set: the SDK only refuses when `window.document` exists, which React Native/Hermes
 * does not have. (It would also be acceptable here, because the key is the person's own and sits in the device's secure
 * store, but there is no reason to opt in.) The SDK uses RN's global `fetch`, non-streaming, and has no other runtime
 * need; its Node-only imports are replaced by the package's own `browser` stubs at bundle time.
 */
import Anthropic from '@anthropic-ai/sdk';

import type { AgentClient } from './agent';
import { describeFailure, type Failure } from './errors';
import { modelRequestOptions } from './models';

export function createAgentClient(apiKey: string): AgentClient {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return { create: (params, options) => client.beta.messages.create(params, options) };
}

export type KeyTest = { ok: true } | { ok: false; failure: Failure };

/** "Test key": one tiny request on the chosen model. Costs a fraction of a cent; shows why a key does not work. */
export async function testApiKey(apiKey: string, model: string): Promise<KeyTest> {
  try {
    const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 30_000 });
    const { fallbacks: _f, betas: _b, ...options } = modelRequestOptions(model);
    await client.messages.create({
      ...options,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, failure: describeFailure(e) };
  }
}
