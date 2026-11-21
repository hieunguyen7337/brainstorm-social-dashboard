/** Pure rules for the saved-login fill and capture in the sign-in sheet (no react-native, no vault storage). */
import { classifyCapture, type CaptureMessage } from '@/src/vault/capture';
import { canFill, takeVaultFill, type FillMessage, type FillStatus } from '@/src/vault/fill';
import { takeHref } from './hrefPoll';
import type { RunnerStatus } from './runner';
import type { Platform } from './types';

export const MAX_FILL_ATTEMPTS = 2;
/** After a fill reports "filled", how long to wait before deciding the saved login did not work. */
export const FILL_CHECK_MS = 8_000;
/** After a login page loaded, wait this long (the form renders) before the saved login is filled in by itself. */
export const AUTO_FILL_DELAY_MS = 900;
/** A fill that found no form yet is tried once more after this long (still within MAX_FILL_ATTEMPTS). */
export const NO_FORM_RETRY_MS = 2_000;

export const SAVED_NOTICE = 'Login saved on this phone. Remove it in Settings > Saved logins.';
export const SAVE_FAILED_NOTICE = "Couldn't save the login on this phone. You can save it in Settings > Saved logins.";
export const FILLING_NOTICE = 'Signing you in with your saved login…';

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
      return "Saved login didn't work. Sign in yourself: Pulse saves the new login once it works.";
    default:
      return null;
  }
}

export interface SheetMessageHandlers {
  /** A login typed on the page (in memory only: hand it to the capture holder, nowhere else). */
  capture(msg: CaptureMessage, sourceUrl: string | null): void;
  fill(f: FillMessage): void;
  href(url: string, sourceUrl: string | null): void;
  runner(raw: string): void;
}

/**
 * Routes one sign-in sheet WebView message. A capture (or anything that names the capture tag) is decided first and never
 * passed on: the runner logs and traces what it is given, so a typed password must never reach it, nor the href poll.
 * `sourceUrl` is react-native-webview's native `nativeEvent.url` (not page-controlled).
 */
export function routeSheetMessage(data: unknown, sourceUrl: string | null | undefined, h: SheetMessageHandlers): void {
  const src = typeof sourceUrl === 'string' ? sourceUrl : null;
  const c = classifyCapture(data);
  if (c.kind === 'capture') {
    h.capture(c.msg, src);
    return;
  }
  if (c.kind === 'junk' || typeof data !== 'string') return;
  const f = takeVaultFill(data);
  if (f) {
    h.fill(f);
    return;
  }
  const href = takeHref(data);
  if (href) h.href(href, src);
  else h.runner(data);
}
