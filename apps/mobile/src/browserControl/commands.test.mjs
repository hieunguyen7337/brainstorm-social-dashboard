// Pure tests for the phone-browser commands. No test framework is installed in apps/mobile, so this uses Node's own:
//   node --experimental-strip-types --test src/browserControl/commands.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import {
  FILL_QUIET_MS,
  MESSAGE_TAG,
  allowedUrl,
  captureBlock,
  describeCommand,
  elementsInShotPixels,
  loginUrl,
  pageArgs,
  pageHasSecret,
  pageScript,
  parseCommand,
  parsePageMessage,
  safeUrl,
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

// ---- secrets never reach the agent: values, URLs, screenshots -----------------------------------------------------

/** A text-typed input (a real DOM `type` property, as on a phone) holding a value, with a fixed on-screen box. */
function input(attrs, value = '') {
  const el = Object.create(HTMLInputElementProxy.prototype);
  Object.assign(el, {
    tagName: 'INPUT',
    type: attrs.type ?? 'text',
    events: [],
    getAttribute: (n) => attrs[n] ?? null,
    focus() {},
    dispatchEvent(e) {
      this.events.push(e.type);
      return true;
    },
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 20, bottom: 30, right: 110 }),
  });
  el.value = value;
  return el;
}

class HTMLInputElementProxy {
  get value() {
    return this._v ?? '';
  }
  set value(v) {
    this._v = v;
  }
}

/** A page whose body holds `fields` (what querySelectorAll returns) and whose activeElement is `active`. */
function pageWith(fields, active) {
  const page = fakePage({ active });
  page.ctx.document.querySelectorAll = () => fields;
  page.ctx.document.elementFromPoint = () => null;
  page.ctx.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' });
  return page;
}

const SECRET_VALUE = 'hunter2-fake';

test('elements never returns the value of a password or one-time-code field, even one typed as text', () => {
  const fields = [
    input({ type: 'text', autocomplete: 'current-password' }, SECRET_VALUE),
    input({ type: 'text', name: 'otp', inputmode: 'numeric' }, '482913'),
    input({ type: 'text', autocomplete: 'one-time-code' }, '482913'),
    input({ type: 'password' }, SECRET_VALUE),
    input({ type: 'text', name: 'q' }, 'cats'),
  ];
  const page = pageWith(fields, null);
  vm.runInNewContext(pageScript({ id: 'e1', action: 'elements', args: {} }, SHOT), page.ctx);
  const res = page.posted[0];
  assert.equal(res.ok, true);
  const dump = JSON.stringify(res);
  assert.ok(!dump.includes(SECRET_VALUE), dump);
  assert.ok(!dump.includes('482913'), dump);
  assert.ok(dump.includes('cats'), 'an ordinary field keeps its value');
  assert.deepEqual(
    res.data.filter((e) => e.secret).map((e) => e.type),
    ['text', 'text', 'text', 'password'],
  );
});

test('a click or press result never names the value of a password field', () => {
  const pw = input({ type: 'text', autocomplete: 'current-password' }, SECRET_VALUE);
  const page = pageWith([pw], pw);
  vm.runInNewContext(pageScript({ id: 'p1', action: 'press', args: { key: 'Tab' } }, SHOT), page.ctx);
  assert.ok(!JSON.stringify(page.posted[0]).includes(SECRET_VALUE), JSON.stringify(page.posted[0]));
});

test('type refuses a password field inside a shadow root', () => {
  const pw = input({ type: 'text', autocomplete: 'current-password' }, '');
  const host = { tagName: 'MY-LOGIN', shadowRoot: { activeElement: pw }, getAttribute: () => null, focus() {} };
  const page = fakePage({ active: host });
  vm.runInNewContext(pageScript({ id: 's1', action: 'type', args: { text: SECRET_VALUE } }, SHOT), page.ctx);
  assert.equal(page.posted[0].ok, false);
  assert.match(page.posted[0].error, /password or code/);
  assert.equal(pw.value, '');
});

test('type refuses a field inside an iframe: nothing is typed and the script never reaches into it', () => {
  const frame = { tagName: 'IFRAME', getAttribute: () => null, focus() {} };
  const page = fakePage({ active: frame });
  vm.runInNewContext(pageScript({ id: 'f1', action: 'type', args: { text: SECRET_VALUE } }, SHOT), page.ctx);
  assert.equal(page.posted[0].ok, false);
});

test('type refuses a password field by its autocomplete value, typed as text', () => {
  const pw = input({ type: 'text', autocomplete: 'current-password' }, '');
  const page = fakePage({ active: pw });
  vm.runInNewContext(pageScript({ id: 'a1', action: 'type', args: { text: SECRET_VALUE } }, SHOT), page.ctx);
  assert.equal(page.posted[0].ok, false);
  assert.equal(pw.value, '');
});

test('safeUrl drops userinfo and fragments and redacts sensitive query values', () => {
  assert.equal(
    safeUrl('https://www.example.com/cb?trk=1&code=hunter2-fake&access_token=hunter2-fake#access_token=hunter2-fake'),
    'https://www.example.com/cb?trk=1&code=REDACTED&access_token=REDACTED',
  );
  assert.equal(safeUrl('https://user:hunter2-fake@www.example.com/a?b=1'), 'https://www.example.com/a?b=1');
  assert.equal(safeUrl('https://www.instagram.com/accounts/login/?next=%2F'), 'https://www.instagram.com/accounts/login/?next=%2F');
  assert.equal(safeUrl('https://x.com/?sig=hunter2-fake&key=hunter2-fake'), 'https://x.com/?sig=REDACTED&key=REDACTED');
  assert.equal(
    safeUrl('https://x.com/cb?oauth_token=hunter2-fake&reset-token=hunter2-fake&trk=1'),
    'https://x.com/cb?oauth_token=REDACTED&reset-token=REDACTED&trk=1',
  );
  assert.equal(safeUrl('about:blank'), 'about:blank');
});

test('page results carry the redacted url, so a one-time code in the address never leaves the phone', () => {
  const msg = JSON.stringify({ tag: MESSAGE_TAG, id: 'u1', ok: true, url: 'https://www.example.com/cb?code=hunter2-fake' });
  assert.equal(parsePageMessage(msg, 'u1').url, 'https://www.example.com/cb?code=REDACTED');
});

test('loginUrl recognises sign-in and challenge pages and leaves ordinary pages alone', () => {
  assert.equal(loginUrl('https://www.instagram.com/accounts/login/'), true);
  assert.equal(loginUrl('https://www.linkedin.com/checkpoint/challenge/AgX?x=1'), true);
  assert.equal(loginUrl('https://www.linkedin.com/login'), true);
  assert.equal(loginUrl('https://x.com/i/flow/login'), true);
  assert.equal(loginUrl('https://accounts.example.com/'), true);
  assert.equal(loginUrl('https://www.linkedin.com/feed/'), false);
  assert.equal(loginUrl('https://www.instagram.com/someone/'), false);
  assert.equal(loginUrl('about:blank'), false);
});

test('a screenshot is blocked on a sign-in page, while a password field is on screen, and for 10 s after a fill', () => {
  const now = 100_000;
  assert.equal(FILL_QUIET_MS, 10_000);
  const calm = { url: 'https://www.linkedin.com/feed/', now, lastFillAt: 0, secretOnPage: false };
  assert.equal(captureBlock(calm), null);
  assert.match(captureBlock({ ...calm, lastFillAt: now - 3_000 }), /types/);
  assert.equal(captureBlock({ ...calm, lastFillAt: now - FILL_QUIET_MS }), null);
  assert.match(captureBlock({ ...calm, url: 'https://www.instagram.com/accounts/login/' }), /sign-in/);
  assert.match(captureBlock({ ...calm, secretOnPage: true }), /password or code/);
  assert.match(captureBlock({ ...calm, secretOnPage: null }), /did not answer/);
});

test('the sign-in check reads the elements probe: a secret field, none, or unknown', () => {
  assert.equal(pageHasSecret({ ok: true, data: [{ tag: 'input', label: '', secret: true }] }), true);
  assert.equal(pageHasSecret({ ok: true, data: [{ tag: 'a', label: 'Home' }] }), false);
  assert.equal(pageHasSecret({ ok: false, error: 'The page did not answer (still loading?). Try again.' }), null);
});
