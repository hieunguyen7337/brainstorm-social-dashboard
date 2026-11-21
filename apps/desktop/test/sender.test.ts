import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppSender } from '../src/main/sender.ts';

test('isAppSender accepts only app://pulse/ frames', () => {
  assert.equal(isAppSender('app://pulse/'), true);
  assert.equal(isAppSender('app://pulse/settings?x=1'), true);
  assert.equal(isAppSender('app://pulse.evil.com/'), false);
  assert.equal(isAppSender('app://pulse'), false);
  assert.equal(isAppSender('https://pulse-hackathon.fly.dev/'), false);
  assert.equal(isAppSender('https://x.com/app://pulse/'), false);
  assert.equal(isAppSender(''), false);
  assert.equal(isAppSender(undefined), false);
  assert.equal(isAppSender(null), false);
});
