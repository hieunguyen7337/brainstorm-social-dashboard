/**
 * The person's own Anthropic API key (Settings > Claude API key): format check and masking. Pure, no react-native import.
 * Storage is `keyStore.ts`. The key is never logged, never sent to Pulse's API and never kept in AsyncStorage.
 */

/** Anthropic keys look like `sk-ant-api03-...` (about 100 characters of letters, digits, `-` and `_`). */
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]+$/;
const MIN_KEY_LENGTH = 40;
const MAX_KEY_LENGTH = 300;

/** What a paste usually brings along: surrounding whitespace, a newline, quotes. */
export function normalizeKey(raw: string): string {
  return (typeof raw === 'string' ? raw : '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
}

/** null when the key is plausible, otherwise what to tell the person. A light check: only Anthropic can say it is valid. */
export function keyProblem(raw: string): string | null {
  const key = normalizeKey(raw);
  if (!key) return 'Paste your Anthropic API key.';
  if (/\s/.test(key)) return 'That has spaces or line breaks in it. Paste only the key.';
  if (!key.startsWith('sk-ant-')) return 'Anthropic API keys start with "sk-ant-". Copy the key from console.anthropic.com.';
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || !KEY_SHAPE.test(key)) {
    return "That doesn't look like a complete Anthropic API key. Copy it again.";
  }
  return null;
}

/** "sk-ant-...WXYZ": the only part of a saved key the app ever shows. */
export function maskKey(key: string): string {
  const k = normalizeKey(key);
  return k.length > 8 ? `sk-ant-…${k.slice(-4)}` : '';
}
