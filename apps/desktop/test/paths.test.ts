import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { contentTypeFor, needsSpaFallback, resolveRendererPath } from '../src/main/paths.ts';

const root = path.resolve('/tmp/pulse-renderer');

test('resolves assets under the root', () => {
  assert.equal(resolveRendererPath(root, '/_expo/static/js/web/app.js'), path.join(root, '_expo/static/js/web/app.js'));
  assert.equal(resolveRendererPath(root, '/favicon.ico'), path.join(root, 'favicon.ico'));
});

test('extension-less paths fall back to index.html', () => {
  assert.equal(needsSpaFallback('/'), true);
  assert.equal(needsSpaFallback('/queue'), true);
  assert.equal(needsSpaFallback('/settings/brand'), true);
  assert.equal(needsSpaFallback('/app.js'), false);
  assert.equal(resolveRendererPath(root, '/'), path.join(root, 'index.html'));
  assert.equal(resolveRendererPath(root, '/queue'), path.join(root, 'index.html'));
});

test('blocks path traversal', () => {
  assert.equal(resolveRendererPath(root, '/../secret.txt'), null);
  assert.equal(resolveRendererPath(root, '/a/../../secret.txt'), null);
  assert.equal(resolveRendererPath(root, '/%2e%2e/secret.txt'), null);
  assert.equal(resolveRendererPath(root, '/..%2fsecret.txt'), null);
  assert.equal(resolveRendererPath(root, '/a%5c..%5csecret.txt'), null);
  assert.equal(resolveRendererPath(root, '/x%00.js'), null);
  assert.equal(resolveRendererPath(root, '/%E0%A4%A'), null);
});

test('content types', () => {
  assert.equal(contentTypeFor('a/b.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('f.TTF'), 'font/ttf');
  assert.equal(contentTypeFor('x.unknown'), 'application/octet-stream');
});
