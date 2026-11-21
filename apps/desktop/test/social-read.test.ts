import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readInWindow,
  SIGNED_OUT,
  type ReadHost,
  type RunnerDepsLike,
  type RunnerLike,
  type RunnerStatusLike,
} from '../src/main/social/read.ts';

function setup(o: { interactive: boolean; startedVisible: boolean }) {
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const calls: string[] = [];
  let deps!: RunnerDepsLike;
  let onClosed: () => void = () => {};
  let onMessage: (raw: string) => void = () => {};
  const runner: RunnerLike = {
    start: () => calls.push('start'),
    navigated: (u, l) => calls.push(`nav ${u} ${l}`),
    loadEnded: (u) => calls.push(`end ${u}`),
    loadFailed: () => calls.push('fail'),
    message: (raw) => calls.push(`msg ${String(raw)}`),
    dispose: () => calls.push('dispose'),
  };
  const host: ReadHost = {
    show: () => calls.push('show'),
    hide: () => calls.push('hide'),
    loadUrl: (u) => calls.push(`load ${u}`),
    inject: (js) => calls.push(`inject ${js}`),
    capture: async () => 'b64',
    onClosed: (cb) => (onClosed = cb),
    onPage: () => undefined,
    onMessage: (cb) => (onMessage = cb),
  };
  const result = readInWindow({
    platform: 'instagram',
    ...o,
    host,
    makeRunner: (d) => ((deps = d), runner),
    readScreenshot: async () => ({}) as never,
    href: { js: 'POLL', ms: 2000, take: (d) => (typeof d === 'string' && d.startsWith('href:') ? d.slice(5) : null) },
    failedReason: 'failed',
    graceMs: 100,
    capMs: 1000,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (id) => void ((id as { live: boolean }).live = false),
    setPoll: (fn) => {
      const t = { fn, ms: -1, live: true };
      timers.push(t);
      return t;
    },
    clearPoll: (id) => void ((id as { live: boolean }).live = false),
  });
  const fire = (ms: number) => timers.filter((t) => t.live && t.ms === ms).forEach((t) => ((t.live = false), t.fn()));
  const status = (s: RunnerStatusLike) => deps.onStatus(s);
  return { result, calls, status, fire, deps: () => deps, close: () => onClosed(), message: (r: string) => onMessage(r) };
}

test('signed-in connect: reaching reading within the grace period never shows the window', async () => {
  const s = setup({ interactive: true, startedVisible: false });
  s.status('login');
  s.status('reading');
  s.fire(100);
  assert.ok(!s.calls.includes('show'));
  s.deps().emitResult({ platform: 'instagram', source: 'device' } as never);
  assert.deepEqual((await s.result).ok, true);
  assert.ok(s.calls.includes('dispose'));
});

test('interactive and still on a login page after the grace period: the window is shown', async () => {
  const s = setup({ interactive: true, startedVisible: false });
  s.status('login');
  s.fire(100);
  assert.equal(s.calls.filter((c) => c === 'show').length, 1);
  s.status('reading'); // past login, but not confirmed signed in yet: stays visible
  assert.ok(!s.calls.includes('hide'));
  s.deps().emitResult({} as never);
  assert.equal((await s.result).ok, true);
  assert.ok(s.calls.includes('hide')); // confirmed: hidden
});

test('confirmation step: once shown, the window is never hidden until a successful result', async () => {
  const s = setup({ interactive: true, startedVisible: false });
  s.status('login');
  s.fire(100);
  for (let i = 0; i < 4; i++) {
    s.status('reading');
    s.status('login');
  }
  s.status('reading');
  assert.equal(s.calls.filter((c) => c === 'show').length, 1);
  assert.equal(s.calls.filter((c) => c === 'hide').length, 0);
  s.deps().emitResult({} as never);
  assert.equal((await s.result).ok, true);
  assert.equal(s.calls.filter((c) => c === 'show').length, 1);
  assert.equal(s.calls.filter((c) => c === 'hide').length, 1);
});

test('background and signed out (login page after the grace period): never shown, signed_out', async () => {
  const s = setup({ interactive: false, startedVisible: false });
  s.status('login');
  s.fire(100);
  assert.deepEqual(await s.result, { ok: false, reason: SIGNED_OUT });
  assert.ok(!s.calls.includes('show'));
});

test('background: signed out in the middle of a read ends at once with signed_out', async () => {
  const s = setup({ interactive: false, startedVisible: false });
  s.status('login');
  s.status('reading');
  s.status('login');
  assert.deepEqual(await s.result, { ok: false, reason: SIGNED_OUT });
  assert.ok(!s.calls.includes('show'));
});

test('interactive: signed out in the middle of a read shows the window at once', async () => {
  const s = setup({ interactive: true, startedVisible: false });
  s.status('login');
  s.status('reading');
  s.status('login');
  assert.ok(s.calls.includes('show'));
  s.deps().emitClose();
  await s.result;
});

test('closing the window resolves { ok: false } with no reason, once', async () => {
  const s = setup({ interactive: true, startedVisible: true });
  s.status('login');
  s.close();
  assert.deepEqual(await s.result, { ok: false });
  s.deps().emitResult({} as never); // ignored after settle
});

test('hidden runs give up at the cap; showing the window cancels the cap', async () => {
  const a = setup({ interactive: false, startedVisible: false });
  a.fire(1000);
  assert.deepEqual(await a.result, { ok: false, reason: 'failed' });
  const b = setup({ interactive: true, startedVisible: false });
  b.status('login');
  b.fire(100);
  b.fire(1000); // cap was cancelled
  b.close();
  assert.deepEqual(await b.result, { ok: false });
});

test('href poll answers go to navigated; other messages go to the runner', async () => {
  const s = setup({ interactive: true, startedVisible: true });
  s.message('href:https://www.instagram.com/');
  s.message('{"pulse":"autoRead"}');
  assert.ok(s.calls.includes('nav https://www.instagram.com/ false'));
  assert.ok(s.calls.includes('msg {"pulse":"autoRead"}'));
  s.close();
  await s.result;
});
