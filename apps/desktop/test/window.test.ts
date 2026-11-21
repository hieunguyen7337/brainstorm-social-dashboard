import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleBarOptions, WINDOW_BG } from '../src/main/window.ts';

test('macOS: hidden inset title bar with traffic lights inside the strip', () => {
  const o = titleBarOptions('darwin', 40);
  assert.equal(o.titleBarStyle, 'hiddenInset');
  assert.deepEqual(o.trafficLightPosition, { x: 16, y: 13 });
});

test('Windows: hidden title bar with a dark overlay matching the strip height', () => {
  const o = titleBarOptions('win32', 40);
  assert.equal(o.titleBarStyle, 'hidden');
  assert.deepEqual(o.titleBarOverlay, { color: WINDOW_BG, symbolColor: '#f4f6ff', height: 40 });
});

test('Linux keeps the native frame', () => {
  assert.deepEqual(titleBarOptions('linux', 40), {});
});
