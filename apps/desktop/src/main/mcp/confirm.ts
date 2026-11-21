/**
 * The in-app publish confirmation (`IPC.confirmRequest` -> the dialog -> `IPC.confirmRespond`). Pure apart from the
 * injected `send`/timers, so it runs under plain Node in tests.
 */
import type { PublishConfirmAnswer, PublishConfirmRequest } from '@/src/desktop/types';
import { randomUUID } from 'node:crypto';

export const CONFIRM_TIMEOUT_MS = 10 * 60_000;
export const MAX_CAPTION = 2200;

export interface ConfirmerDeps {
  /** Sends the request to the app; false when there is no window to show it in. */
  send(req: PublishConfirmRequest): boolean;
  maxBytes: number;
  base64Size(b64: string): number;
  timeoutMs?: number;
  newId?: () => string;
}

export interface Confirmer {
  /** Resolves with the person's answer; `{ ok: false }` for a cancel, a timeout, a bad answer or no window. */
  ask(req: Omit<PublishConfirmRequest, 'id'>): Promise<PublishConfirmAnswer>;
  /** The IPC handler body. Ignores unknown ids; a malformed answer for a known id is a cancel (the dialog has closed). */
  respond(id: unknown, answer: unknown): void;
  pending(): number;
}

/** A valid ok answer, or `{ ok: false }` for a cancel, null when the shape is wrong. */
export function parseAnswer(
  answer: unknown,
  maxBytes: number,
  base64Size: (b64: string) => number,
): PublishConfirmAnswer | null {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as Record<string, unknown>;
  if (typeof a.ok !== 'boolean') return null;
  if (!a.ok) return { ok: false };
  if (typeof a.caption !== 'string' || a.caption.length > MAX_CAPTION) return null;
  if (a.mediaType !== 'image/jpeg' && a.mediaType !== 'image/png') return null;
  if (typeof a.imageBase64 !== 'string' || a.imageBase64.length === 0) return null;
  if (base64Size(a.imageBase64) > maxBytes) return null;
  return { ok: true, caption: a.caption, mediaType: a.mediaType, imageBase64: a.imageBase64 };
}

export function createConfirmer(deps: ConfirmerDeps): Confirmer {
  const waiting = new Map<string, (a: PublishConfirmAnswer) => void>();
  const timeoutMs = deps.timeoutMs ?? CONFIRM_TIMEOUT_MS;
  const newId = deps.newId ?? randomUUID;
  return {
    ask(req) {
      const id = newId();
      return new Promise<PublishConfirmAnswer>((resolve) => {
        const timer = setTimeout(() => done({ ok: false }), timeoutMs);
        const done = (a: PublishConfirmAnswer): void => {
          clearTimeout(timer);
          waiting.delete(id);
          resolve(a);
        };
        waiting.set(id, done);
        if (!deps.send({ ...req, id })) done({ ok: false });
      });
    },
    respond(id, answer) {
      if (typeof id !== 'string') return;
      const done = waiting.get(id);
      if (!done) return;
      const parsed = parseAnswer(answer, deps.maxBytes, deps.base64Size);
      done(parsed ?? { ok: false });
    },
    pending: () => waiting.size,
  };
}
