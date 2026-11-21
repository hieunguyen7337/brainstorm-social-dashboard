import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessageHub } from '../src/main/social/messages.ts';
import { cleanUserAgent, isSignedIn, isSocialPlatform, partitionFor, SIGNED_IN_COOKIE } from '../src/main/social/sessions.ts';
import { createStore } from '../src/main/social/store.ts';
import { imageToJpegBase64, type ImageLike } from '../src/main/social/capture.ts';

test('page messages are accepted only from the attached webContents', () => {
  const hub = createMessageHub();
  const mine = { id: 1 };
  const other = { id: 2 };
  const got: string[] = [];
  const detach = hub.attach(mine, (r) => got.push(r));
  assert.equal(hub.deliver(mine, '{"a":1}'), true);
  assert.equal(hub.deliver(other, '{"a":2}'), false);
  assert.equal(hub.deliver(mine, { not: 'a string' }), false);
  assert.equal(hub.deliver(mine, 'x'.repeat(1_000_001)), false);
  detach();
  assert.equal(hub.deliver(mine, '{"a":3}'), false);
  assert.deepEqual(got, ['{"a":1}']);
});

const jar = (cookies: Array<{ name: string; domain?: string; value?: string }>) => ({
  get: async (f: { name?: string }) => cookies.filter((c) => !f.name || c.name === f.name),
});

test('signed-in check is by cookie name and domain only', async () => {
  assert.equal(await isSignedIn(jar([{ name: 'sessionid', domain: '.instagram.com', value: 'secret' }]), 'instagram'), true);
  assert.equal(await isSignedIn(jar([{ name: 'sessionid', domain: 'evil.com' }]), 'instagram'), false);
  assert.equal(await isSignedIn(jar([{ name: 'sessionid', domain: 'notinstagram.com' }]), 'instagram'), false);
  assert.equal(await isSignedIn(jar([{ name: 'csrftoken', domain: '.instagram.com' }]), 'instagram'), false);
  assert.equal(await isSignedIn(jar([{ name: 'li_at', domain: '.www.linkedin.com' }]), 'linkedin'), true);
  assert.equal(await isSignedIn(jar([{ name: 'auth_token', domain: '.x.com' }]), 'x'), true);
  assert.equal(await isSignedIn({ get: async () => Promise.reject(new Error('x')) }, 'x'), false);
});

test('cookie names per platform match docs/DESKTOP.md 4.4', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(SIGNED_IN_COOKIE).map(([p, c]) => [p, c.name])),
    { instagram: 'sessionid', linkedin: 'li_at', x: 'auth_token', tiktok: 'sessionid', facebook: 'c_user', reddit: 'reddit_session' },
  );
});

test('platform validation and partition names', () => {
  assert.equal(isSocialPlatform('instagram'), true);
  for (const bad of ['', 'youtube', null, undefined, 3, '__proto__']) assert.equal(isSocialPlatform(bad), false);
  assert.equal(partitionFor('x'), 'persist:pulse-x');
});

test('user agent loses the Electron and app-name tokens', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) pulse-desktop/0.1.0 Chrome/140.0.0.0 Electron/45.4.1 Safari/537.36';
  assert.equal(
    cleanUserAgent(ua, ['pulse-desktop']),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  );
  assert.ok(!cleanUserAgent(ua.replace('pulse-desktop', 'Pulse-Desktop'), ['Pulse Desktop']).includes('Pulse'));
});

test('store keeps lastReadAt across instances', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-store-')), 's.json');
  const a = createStore(file);
  assert.equal(a.get('x'), null);
  a.set('x', '2026-11-21T00:00:00.000Z');
  assert.equal(createStore(file).get('x'), '2026-11-21T00:00:00.000Z');
  a.clear('x');
  assert.equal(createStore(file).get('x'), null);
  fs.writeFileSync(file, 'not json');
  assert.equal(createStore(file).get('x'), null);
});

function fakeImage(width: number, bytesAt: (w: number) => number): ImageLike {
  const make = (w: number): ImageLike => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: w }),
    resize: (o) => make(o.width),
    toJPEG: () => ({ length: bytesAt(w), toString: () => `jpeg${w}` }),
  });
  return make(width);
}
const limits = { maxWidth: 1400, quality: 0.8, retryWidth: 900, retryQuality: 0.6, maxBytes: 1000 };

test('capture is resized to the width cap, retried smaller when too big, and rejects when empty', () => {
  assert.equal(imageToJpegBase64(fakeImage(2800, () => 10), limits), 'jpeg1400');
  assert.equal(imageToJpegBase64(fakeImage(2800, (w) => (w > 900 ? 5000 : 10)), limits), 'jpeg900');
  assert.throws(() => imageToJpegBase64(fakeImage(2800, () => 5000), limits), /too large/);
  assert.throws(() => imageToJpegBase64({ ...fakeImage(10, () => 1), isEmpty: () => true }, limits), /empty/);
});
