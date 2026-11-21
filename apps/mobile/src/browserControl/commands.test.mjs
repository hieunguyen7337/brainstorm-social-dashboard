// Pure tests for the phone-browser commands. No test framework is installed in apps/mobile, so this uses Node's own:
//   node --experimental-strip-types --test src/browserControl/commands.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import {
  MESSAGE_TAG,
  allowedUrl,
  describeCommand,
  elementsInShotPixels,
  pageArgs,
  pageScript,
  parseCommand,
  parsePageMessage,
  shotSize,
} from './commands.ts';

test('only https pages load', () => {
  assert.equal(allowedUrl('https://www.instagram.com/'), true);
  assert.equal(allowedUrl('about:blank'), true);
  assert.equal(allowedUrl('http://example.com/'), false);
  assert.equal(allowedUrl('intent://scan/#Intent;end'), false);
  assert.equal(allowedUrl('instagram://user?username=x'), false);
  assert.equal(allowedUrl('javascript:alert(1)'), false);
  assert.equal(allowedUrl('file:///sdcard/x'), false);
});

test('parseCommand checks the command again on the phone', () => {
  assert.deepEqual(parseCommand({ id: 'a', action: 'open', args: { url: 'https://x.com/' } }), {
    cmd: { id: 'a', action: 'open', args: { url: 'https://x.com/' } },
  });
  assert.equal(parseCommand({ id: 'a', action: 'open', args: { url: 'http://x.com/' } }).error, 'Only https:// pages can be opened.');
  assert.equal(parseCommand({ id: 'a', action: 'eval', args: {} }).id, 'a');
  assert.ok('error' in parseCommand({ id: 'a', action: 'type', args: { text: '' } }));
  assert.ok('error' in parseCommand({ id: 'a', action: 'press', args: { key: 'F5' } }));
  assert.ok('error' in parseCommand(null));
  assert.deepEqual(parseCommand({ id: 'b', action: 'screenshot' }), { cmd: { id: 'b', action: 'screenshot', args: {} } });
});

test('screenshot size and click coordinates line up', () => {
  const shot = shotSize(400, 800, 2.7);
  assert.deepEqual(shot, { w: 720, h: 1440 });
  assert.deepEqual(shotSize(300, 600, 2), { w: 600, h: 1200 });
  assert.deepEqual(shotSize(0, 600, 2), { w: 0, h: 0 });
  const args = pageArgs({ id: 'c', action: 'click', args: { x: 360, y: 1440 } }, shot);
  assert.deepEqual(args, { fx: 0.5, fy: 1 });
  assert.deepEqual(pageArgs({ id: 'c', action: 'click', args: { x: 9999, y: -5 } }, shot), { fx: 1, fy: 0 });
  assert.deepEqual(pageArgs({ id: 'c', action: 'click', args: { text: 'Post' } }, shot), { text: 'Post' });
  assert.deepEqual(elementsInShotPixels([{ tag: 'button', label: 'Post', fx: 0.25, fy: 0.5 }, 'junk'], shot), [
    { tag: 'button', label: 'Post', x: 180, y: 720 },
  ]);
});

test('banner text says what Claude does, including what it types', () => {
  assert.equal(describeCommand({ id: '1', action: 'open', args: { url: 'https://www.linkedin.com/feed/' } }), 'Opening www.linkedin.com');
  assert.equal(describeCommand({ id: '1', action: 'type', args: { text: 'Hello' } }), 'Typing "Hello"');
  assert.equal(describeCommand({ id: '1', action: 'click', args: { x: 1, y: 2 } }), 'Tapping the screen');
  assert.equal(describeCommand({ id: '1', action: 'scroll', args: { dy: -100 } }), 'Scrolling up');
});

test('parsePageMessage keeps only our messages', () => {
  const msg = JSON.stringify({ tag: MESSAGE_TAG, id: 'x', ok: true, text: 'hi', url: 'https://a.b/', title: 'T' });
  assert.deepEqual(parsePageMessage(msg, 'x'), { id: 'x', ok: true, text: 'hi', url: 'https://a.b/', title: 'T' });
  assert.equal(parsePageMessage(msg, 'other'), null);
  assert.equal(parsePageMessage('{"pulse":"autoRead"}'), null);
  assert.equal(parsePageMessage('not json'), null);
});

// ---- the injected script, run against a tiny fake page ------------------------------------------------------------

function fakePage({ active, body = 'Hello page' } = {}) {
  const posted = [];
  class HTMLInputElement {
    get value() {
      return this._v ?? '';
    }
    set value(v) {
      this._v = v;
    }
  }
  class HTMLTextAreaElement {
    get value() {
      return this._v ?? '';
    }
    set value(v) {
      this._v = v;
    }
  }
  class Ev {
    constructor(type, o) {
      this.type = type;
      Object.assign(this, o);
    }
  }
  const documentBody = { innerText: body, tagName: 'BODY' };
  const ctx = {
    window: { ReactNativeWebView: { postMessage: (s) => posted.push(JSON.parse(s)) }, innerWidth: 400, innerHeight: 800 },
    location: { href: 'https://example.com/' },
    document: { title: 'Example', body: documentBody, documentElement: {}, activeElement: active ?? documentBody },
    HTMLInputElement,
    HTMLTextAreaElement,
    InputEvent: Ev,
    Event: Ev,
    KeyboardEvent: Ev,
  };
  return { ctx, posted, HTMLInputElement, HTMLTextAreaElement };
}

function field(proto, attrs, tagName) {
  const el = Object.create(proto);
  Object.assign(el, {
    tagName,
    events: [],
    getAttribute: (n) => attrs[n] ?? null,
    focus() {},
    dispatchEvent(e) {
      this.events.push(e.type);
      return true;
    },
  });
  return el;
}

const SHOT = { w: 720, h: 1440 };

test('the page script is valid JavaScript for every page action', () => {
  for (const action of ['click', 'type', 'press', 'scroll', 'read_text', 'elements']) {
    new vm.Script(pageScript({ id: 'i', action, args: { text: 'x', key: 'Enter' } }, SHOT));
  }
});

test('read_text posts the visible text with the url and title', () => {
  const page = fakePage({ body: 'Followers 1,204' });
  vm.runInNewContext(pageScript({ id: 'r1', action: 'read_text', args: {} }, SHOT), page.ctx);
  assert.equal(page.posted.length, 1);
  const res = parsePageMessage(JSON.stringify(page.posted[0]), 'r1');
  assert.deepEqual(res, { id: 'r1', ok: true, text: 'Followers 1,204', url: 'https://example.com/', title: 'Example' });
});

test('type refuses a password field', () => {
  const tmp = fakePage();
  const pw = field(tmp.HTMLInputElement.prototype, { type: 'password' }, 'INPUT');
  const page = fakePage({ active: pw });
  vm.runInNewContext(pageScript({ id: 't1', action: 'type', args: { text: 'hunter2' } }, SHOT), page.ctx);
  assert.equal(page.posted[0].ok, false);
  assert.match(page.posted[0].error, /password/);
  assert.equal(pw.value, '');
});

test('type refuses a one-time-code field', () => {
  const tmp = fakePage();
  const otp = field(tmp.HTMLInputElement.prototype, { type: 'text', autocomplete: 'one-time-code' }, 'INPUT');
  const page = fakePage({ active: otp });
  vm.runInNewContext(pageScript({ id: 't2', action: 'type', args: { text: '123456' } }, SHOT), page.ctx);
  assert.equal(page.posted[0].ok, false);
});

test('type fills a focused textarea through the native setter and fires input/change', () => {
  const page = fakePage();
  const ta = field(page.HTMLTextAreaElement.prototype, {}, 'TEXTAREA');
  page.ctx.document.activeElement = ta;
  ta.value = 'Hi';
  vm.runInNewContext(pageScript({ id: 't3', action: 'type', args: { text: ' there', clear: false } }, SHOT), page.ctx);
  assert.equal(page.posted[0].ok, true, page.posted[0].error);
  assert.equal(ta.value, 'Hi there');
  assert.deepEqual(ta.events, ['input', 'change']);
});

test('type with nothing focused asks for a click first', () => {
  const page = fakePage();
  vm.runInNewContext(pageScript({ id: 't4', action: 'type', args: { text: 'x' } }, SHOT), page.ctx);
  assert.equal(page.posted[0].ok, false);
  assert.match(page.posted[0].error, /click the field first/);
});
