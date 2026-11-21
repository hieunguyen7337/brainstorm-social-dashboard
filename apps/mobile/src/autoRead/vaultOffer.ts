/** Pure rules for offering the saved-login fill in the sign-in sheet (no react-native, no vault storage). */
import { canFill, type FillStatus } from '@/src/vault/fill';
import type { RunnerStatus } from './runner';
import type { Platform } from './types';

export const MAX_FILL_ATTEMPTS = 2;
/** After a fill reports "filled", how long to wait before deciding the saved login did not work. */
export const FILL_CHECK_MS = 8_000;

export function offerVaultFill(
  platform: Platform,
  s: { status: RunnerStatus; hasLogin: boolean; url: string | null; attempts: number; dismissed: boolean },
): boolean {
  return (
    s.status === 'login' && s.hasLogin && !s.dismissed && s.attempts < MAX_FILL_ATTEMPTS && canFill(platform, s.url)
  );
}

export function fillNote(kind: FillStatus | 'unreadable' | 'failed', label: string): string | null {
  switch (kind) {
    case 'unreadable':
      return `Couldn't unlock your saved ${label} login. Sign in yourself.`;
    case 'no_form':
      return `Couldn't find the ${label} sign-in form on this page. Sign in yourself.`;
    case 'wrong_host':
      return `This isn't ${label}'s sign-in page, so Pulse didn't fill it.`;
    case 'failed':
      return "Saved login didn't work. Sign in yourself or replace it in Settings.";
    default:
      return null;
  }
}
