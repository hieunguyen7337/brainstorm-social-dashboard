import { execFile } from 'node:child_process';
import type { ClaudeState } from '@/src/desktop/types';

export const MIN_VERSION = '2.0.0';

function run(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] } as never,
      (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '') }),
    );
  });
}

export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** A non-sensitive label from `auth status --json` (never the email or org). */
export function accountLabel(json: Record<string, unknown>): string | undefined {
  const sub = typeof json.subscriptionType === 'string' ? json.subscriptionType : '';
  const method = typeof json.authMethod === 'string' ? json.authMethod : '';
  const label = [method, sub].filter(Boolean).join(' ');
  return label ? label.slice(0, 60) : undefined;
}

export interface StatusOptions {
  versionTimeoutMs?: number;
  authTimeoutMs?: number;
  minVersion?: string;
}

export async function checkStatus(bin: string | null, opts: StatusOptions = {}): Promise<ClaudeState> {
  if (!bin) return { state: 'not_found' };
  const v = await run(bin, ['--version'], opts.versionTimeoutMs ?? 8000);
  const version = v.ok ? parseVersion(v.stdout) : null;
  if (!version) return { state: 'not_found' };
  const minimum = opts.minVersion ?? MIN_VERSION;
  if (compareVersions(version, minimum) < 0) return { state: 'too_old', version, minimum };

  const a = await run(bin, ['auth', 'status', '--json'], opts.authTimeoutMs ?? 10000);
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(a.stdout);
    if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
  } catch {
    // not JSON: treated as signed out below
  }
  // A timeout or failure cannot be told apart from signed out; the app offers "Check again".
  if (!json || json.loggedIn !== true) return { state: 'signed_out', version };
  const account = accountLabel(json);
  return account ? { state: 'ready', version, account } : { state: 'ready', version };
}
