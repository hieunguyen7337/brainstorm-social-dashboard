import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocialService, SIGNED_OUT, type RunReadArgs } from '../src/main/social/service.ts';
import { TaskQueue, type SocialWindow } from '../src/main/social/window.ts';
import type { ConnectResult } from '@/src/desktop/types';

const windows: Array<SocialWindow & { close(): void }> = [];

function fakeWindow(visible: boolean, created: Array<{ visible: boolean; destroyed: boolean }>) {
  const rec = { visible, destroyed: false };
  created.push(rec);
  const closed: Array<() => void> = [];
  const win = {
    webContents: { id: created.length } as never,
    show() {
      rec.visible = true;
    },
    hide() {
      rec.visible = false;
    },
    destroy() {
      rec.destroyed = true;
    },
    loadUrl: async () => undefined,
    onClosed: (cb: () => void) => void closed.push(cb),
    close: () => closed.forEach((cb) => cb()),
  };
  windows.push(win as never);
  return win as SocialWindow & { close(): void };
}

function setup(opts: { signedIn: boolean; result?: ConnectResult }) {
  const created: Array<{ visible: boolean; destroyed: boolean }> = [];
  const reads: RunReadArgs[] = [];
  const stored = new Map<string, string>();
  const queue = new TaskQueue<SocialWindow>((_p, visible) => fakeWindow(visible, created));
  const service = createSocialService({
    queue,
    isSignedIn: async () => opts.signedIn,
    clearSession: async (p) => void stored.delete(p),
    store: {
      get: (p) => stored.get(p) ?? null,
      set: (p, iso) => void stored.set(p, iso),
      clear: (p) => void stored.delete(p),
    },
    runRead: async (args) => {
      reads.push(args);
      return opts.result ?? { ok: false, reason: 'x' };
    },
    onPageMessage: () => () => undefined,
    now: () => new Date('2026-11-21T00:00:00Z'),
  });
  return { service, created, reads, stored };
}

test('connect while signed out: the window is visible from the start (interactive)', async () => {
  const s = setup({ signedIn: false });
  await s.service.connect('instagram');
  assert.equal(s.created.length, 1);
  assert.equal(s.created[0].visible, true);
  assert.equal(s.created[0].destroyed, true);
  assert.deepEqual([s.reads[0].interactive, s.reads[0].startedVisible], [true, true]);
});

test('connect while signed in: hidden window, interactive, success stores lastReadAt', async () => {
  const read = { platform: 'instagram', source: 'device' } as never;
  const s = setup({ signedIn: true, result: { ok: true, read } });
  const r = await s.service.connect('instagram');
  assert.equal(r.ok, true);
  assert.equal(s.created[0].visible, false);
  assert.deepEqual([s.reads[0].interactive, s.reads[0].startedVisible], [true, false]);
  assert.equal(s.stored.get('instagram'), '2026-11-21T00:00:00.000Z');
  assert.equal((await s.service.status()).instagram.lastReadAt, '2026-11-21T00:00:00.000Z');
});

test('a failed connect does not store lastReadAt', async () => {
  const s = setup({ signedIn: true, result: { ok: false } });
  await s.service.connect('x');
  assert.equal(s.stored.size, 0);
});

test('background read while signed out: no window at all, signed_out result', async () => {
  const s = setup({ signedIn: false });
  const r = await s.service.read('instagram');
  assert.deepEqual(r, { ok: false, reason: SIGNED_OUT });
  assert.equal(s.created.length, 0);
  assert.equal(s.reads.length, 0);
});

test('background read while signed in: hidden and non-interactive', async () => {
  const s = setup({ signedIn: true });
  await s.service.read('instagram');
  assert.equal(s.created[0].visible, false);
  assert.equal(s.reads[0].interactive, false);
});

test('signOut clears the session and lastReadAt', async () => {
  const s = setup({ signedIn: true });
  s.stored.set('instagram', 'x');
  await s.service.signOut('instagram');
  assert.equal(s.stored.has('instagram'), false);
});

test('runTask rejects non-http urls', async () => {
  const s = setup({ signedIn: true });
  await assert.rejects(s.service.runTask('instagram', { url: 'file:///etc/passwd' }, async () => 1), /Invalid url/);
  assert.equal(s.created.length, 0);
});

test('runTask rejects when its window is closed, and the queue moves on', async () => {
  windows.length = 0;
  const s = setup({ signedIn: true });
  const p = s.service.runTask('instagram', { url: 'https://www.instagram.com/', visible: true }, () => new Promise(() => {}));
  const next = s.service.runTask('x', { url: 'https://x.com/home' }, async () => 'next');
  await new Promise((r) => setImmediate(r));
  windows[0].close();
  await assert.rejects(p, /Window closed/);
  assert.equal(await next, 'next');
  assert.ok(s.created.every((c) => c.destroyed));
});
