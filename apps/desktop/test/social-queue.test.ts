import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../src/main/social/window.ts';

function setup() {
  const log: string[] = [];
  let alive = 0;
  let maxAlive = 0;
  let n = 0;
  const queue = new TaskQueue((platform, visible) => {
    const id = ++n;
    alive += 1;
    maxAlive = Math.max(maxAlive, alive);
    log.push(`create ${id} ${platform} ${visible}`);
    return {
      id,
      destroy() {
        alive -= 1;
        log.push(`destroy ${id}`);
      },
    };
  });
  return { queue, log, alive: () => alive, maxAlive: () => maxAlive };
}

test('one window at a time, destroyed after each task, none when idle', async () => {
  const s = setup();
  let release!: () => void;
  const gate = { promise: new Promise<void>((r) => (release = r)) };
  const a = s.queue.run('instagram', { visible: false }, async () => {
    await gate.promise;
    return 'a';
  });
  const b = s.queue.run('x', { visible: true }, async () => 'b');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.alive(), 1);
  assert.equal(s.queue.pending, 1);
  release();
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.equal(s.maxAlive(), 1);
  assert.equal(s.alive(), 0);
  assert.equal(s.queue.current, null);
  assert.deepEqual(s.log, ['create 1 instagram false', 'destroy 1', 'create 2 x true', 'destroy 2']);
});

test('a failing task destroys its window and releases the queue', async () => {
  const s = setup();
  const bad = s.queue.run('instagram', { visible: false }, async () => {
    throw new Error('boom');
  });
  const good = s.queue.run('instagram', { visible: false }, async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
  assert.equal(s.alive(), 0);
});

test('a window factory that throws does not block the queue', async () => {
  let first = true;
  const queue = new TaskQueue(() => {
    if (first) {
      first = false;
      throw new Error('no window');
    }
    return { destroy() {} };
  });
  await assert.rejects(queue.run('x', { visible: false }, async () => 1), /no window/);
  assert.equal(await queue.run('x', { visible: false }, async () => 2), 2);
});
