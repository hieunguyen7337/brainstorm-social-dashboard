import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as logic from '../../mobile/src/igPost/logic.ts';
import { createInstagramPoster, imageSize } from '../src/main/social/post.ts';

function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0, 4, 0, 0]), sof, Buffer.alloc(8)]);
}

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

test('imageSize reads JPEG and PNG headers', () => {
  assert.deepEqual(imageSize(jpeg(1080, 1080)), { width: 1080, height: 1080 });
  assert.deepEqual(imageSize(png(640, 480)), { width: 640, height: 480 });
  assert.equal(imageSize(Buffer.from('hello world, not an image')), null);
});

type Listener = (raw: string) => void;

/** A fake instagram page: answers the state probe, and the post script with `result`. */
function fakeSocial(page: { state: object; result: object | null }) {
  let listener: Listener = () => undefined;
  const injected: string[] = [];
  const wc = {
    isDestroyed: () => false,
    executeJavaScript: async (js: string) => {
      injected.push(js);
      if (js.includes("kind: 'state'")) {
        setImmediate(() => listener(JSON.stringify({ t: logic.IG_MSG, kind: 'state', ...page.state })));
      } else if (js.includes('/api/v1/media/configure/') && page.result) {
        setImmediate(() => listener(JSON.stringify({ t: logic.IG_MSG, kind: 'result', ...page.result })));
      }
      return undefined;
    },
  };
  const tasks: Array<{ platform: string; url: string; visible?: boolean }> = [];
  const social = {
    runTask: async (platform: string, opts: { url: string; visible?: boolean }, task: (w: never) => Promise<unknown>) => {
      tasks.push({ platform, ...opts });
      return task(wc as never);
    },
    onPageMessage: (_wc: unknown, cb: Listener) => {
      listener = cb;
      return () => undefined;
    },
  };
  return { social: social as never, injected, tasks };
}

const req = () => ({ caption: 'Hello #pulse', imageBase64: jpeg(1080, 1080).toString('base64'), mediaType: 'image/jpeg' as const });
const fast = { probeMs: 5, readyMs: 200, timeoutMs: 100 };

test('poster: signed in -> chunks, script with caption, returns the post url', async () => {
  const f = fakeSocial({ state: { onIg: true, signedIn: true, settled: true }, result: { ok: true, code: 'Cabc_1' } });
  const out = await createInstagramPoster(f.social, logic, fast)(req());
  assert.deepEqual(out, { ok: true, code: 'Cabc_1', url: 'https://www.instagram.com/p/Cabc_1/' });
  assert.deepEqual(f.tasks, [{ platform: 'instagram', url: logic.IG_HOME_URL, visible: false }]);
  assert.ok(f.injected.some((s) => s.includes('window.__pulseIgImg +=')));
  assert.ok(f.injected.some((s) => s.includes('Hello #pulse')));
});

test('poster: signed out page -> signed-out failure, nothing injected for the post', async () => {
  const f = fakeSocial({ state: { onIg: true, signedIn: false, settled: true }, result: null });
  const out = await createInstagramPoster(f.social, logic, fast)(req());
  assert.equal(out.ok, false);
  assert.match(out.ok ? '' : out.text, /sign in again/);
  assert.ok(!f.injected.some((s) => s.includes('__pulseIgImg')));
});

test('poster: Instagram refusing is a failure with the stage text', async () => {
  const f = fakeSocial({
    state: { onIg: true, signedIn: true, settled: true },
    result: { ok: false, stage: 'configure', status: 403, message: 'x' },
  });
  const out = await createInstagramPoster(f.social, logic, fast)(req());
  assert.equal(out.ok, false);
  assert.match(out.ok ? '' : out.text, /refused/);
});

test('poster: no answer from the script times out with a check-your-profile text', async () => {
  const f = fakeSocial({ state: { onIg: true, signedIn: true, settled: true }, result: null });
  const out = await createInstagramPoster(f.social, logic, fast)(req());
  assert.equal(out.ok, false);
  assert.match(out.ok ? '' : out.text, /check their profile/);
});

test('poster: bad images are refused before any window opens', async () => {
  const f = fakeSocial({ state: { onIg: true, signedIn: true, settled: true }, result: null });
  const poster = createInstagramPoster(f.social, logic, fast);
  assert.equal((await poster({ ...req(), imageBase64: Buffer.from('nope').toString('base64') })).ok, false);
  assert.equal((await poster({ ...req(), imageBase64: jpeg(1000, 200).toString('base64') })).ok, false);
  assert.equal((await poster({ ...req(), mediaType: 'image/png', imageBase64: png(1080, 1080).toString('base64') })).ok, false);
  assert.equal(f.tasks.length, 0);
});
