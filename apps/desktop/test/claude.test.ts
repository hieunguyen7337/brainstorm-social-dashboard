import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildArgs, validateRun, SYSTEM_PROMPT } from '../src/main/claude/args.ts';
import { ClaudeBridge } from '../src/main/claude/bridge.ts';
import { buildMcpConfig, removeMcpConfig, writeMcpConfig } from '../src/main/claude/mcpConfig.ts';
import { locateClaude, readSavedBin, saveBin } from '../src/main/claude/locate.ts';
import { checkStatus, compareVersions, parseVersion } from '../src/main/claude/status.ts';

let tmp: string;
const script = (name: string, body: string): string => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
};
// Windows ignores POSIX mode bits (files report 0o666), so mode assertions run on POSIX only.
const posixMode = process.platform !== 'win32';
const UUID = '123e4567-e89b-42d3-a456-426614174000';

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-claude-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- args

test('buildArgs: spawn contract, prompt after --', () => {
  const a = buildArgs({ prompt: '-hi there' }, '/x/mcp.json');
  assert.deepEqual(a.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
  assert.ok(!a.includes('--resume'));
  assert.deepEqual(a.slice(a.indexOf('--mcp-config'), a.indexOf('--mcp-config') + 3), ['--mcp-config', '/x/mcp.json', '--strict-mcp-config']);
  assert.deepEqual(a.slice(a.indexOf('--tools'), a.indexOf('--tools') + 2), ['--tools', '']);
  const at = a.indexOf('--allowedTools');
  assert.deepEqual(a.slice(at, at + 3), ['--allowedTools', 'mcp__pulse', 'mcp__pulse_desktop']);
  assert.equal(a[a.indexOf('--append-system-prompt') + 1], SYSTEM_PROMPT);
  assert.deepEqual(a.slice(-2), ['--', '-hi there']);
});

test('buildArgs: --resume, and no token anywhere in argv', () => {
  const a = buildArgs({ prompt: 'x', sessionId: UUID }, '/x/mcp.json');
  assert.deepEqual(a.slice(5, 7), ['--resume', UUID]);
  assert.ok(!a.join(' ').includes('Bearer'));
});

test('validateRun', () => {
  assert.deepEqual(validateRun({ prompt: 'hi' }), { prompt: 'hi' });
  assert.deepEqual(validateRun({ prompt: 'hi', sessionId: UUID }), { prompt: 'hi', sessionId: UUID });
  assert.deepEqual(validateRun({ prompt: 'hi', sessionId: '' }), { prompt: 'hi' });
  for (const bad of [null, 'x', {}, { prompt: '  ' }, { prompt: 5 }, { prompt: 'a'.repeat(20_001) },
    { prompt: 'a', sessionId: 'abc' }, { prompt: 'a', sessionId: '--x' }, { prompt: 'a', sessionId: 7 }]) {
    assert.throws(() => validateRun(bad));
  }
});

// ---- mcp.json

test('mcp config: token and desktop server presence, mode 0600, removal', () => {
  const file = path.join(tmp, 'mcp.json');
  writeMcpConfig(file, 'https://api.example', 'tok-1', { url: 'http://127.0.0.1:5000/mcp', token: 'loc-2' });
  if (posixMode) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    mcpServers: {
      pulse: { type: 'http', url: 'https://api.example/mcp', headers: { Authorization: 'Bearer tok-1' } },
      pulse_desktop: { type: 'http', url: 'http://127.0.0.1:5000/mcp', headers: { Authorization: 'Bearer loc-2' } },
    },
  });
  fs.chmodSync(file, 0o644); // an existing looser file is tightened on rewrite
  writeMcpConfig(file, 'https://api.example', null, null);
  if (posixMode) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: {} });
  assert.deepEqual(Object.keys(buildMcpConfig('https://a', 'T', null).mcpServers), ['pulse']);
  assert.deepEqual(Object.keys(buildMcpConfig('https://a', null, { url: 'u', token: 't' }).mcpServers), ['pulse_desktop']);
  removeMcpConfig(file);
  assert.equal(fs.existsSync(file), false);
});

// ---- bridge

type Ev = { runId: string; event: { type: string; [k: string]: unknown } };
function makeBridge(bin: string | null, extra: { killGraceMs?: number } = {}) {
  const events: Ev[] = [];
  const bridge = new ClaudeBridge({
    resolveBin: async () => bin,
    writeMcpConfig: () => '/x/mcp.json',
    workDir: tmp,
    send: (runId, event) => events.push({ runId, event: event as Ev['event'] }),
    ...extra,
  });
  const done = async () => {
    for (let i = 0; i < 300 && !events.some((e) => e.event.type === 'done'); i++) await new Promise((r) => setTimeout(r, 20));
    return events;
  };
  return { bridge, events, done };
}

test('bridge forwards json, stderr (incl. non-JSON stdout line) and done', async () => {
  const fake = script('fake.js', `
console.log(JSON.stringify({type:'system',argv:process.argv.slice(2),cwd:process.cwd()}));
console.log('not json');
process.stderr.write('warn line\\n');
console.log(JSON.stringify({type:'result'}));`);
  const { bridge, done } = makeBridge(fake);
  const { runId } = await bridge.run({ prompt: 'hello', sessionId: UUID });
  const events = await done();
  assert.ok(events.every((e) => e.runId === runId));
  const types = events.map((e) => e.event.type);
  assert.equal(types.at(-1), 'done');
  assert.deepEqual(events.at(-1)?.event, { type: 'done', code: 0 });
  const sys = events.find((e) => e.event.type === 'json')?.event.data as { argv: string[]; cwd: string };
  assert.ok(sys.argv.includes('hello') && sys.argv.includes('--resume'));
  assert.equal(fs.realpathSync(sys.cwd), fs.realpathSync(tmp));
  const stderr = events.filter((e) => e.event.type === 'stderr').map((e) => e.event.line);
  assert.deepEqual(stderr.sort(), ['not json', 'warn line']);
  assert.equal(events.filter((e) => e.event.type === 'json').length, 2);
  assert.equal(bridge.running, false);
});

test('bridge rejects a second concurrent run, accepts one after done', async () => {
  const fake = script('slow.js', `setTimeout(()=>console.log('{"type":"result"}'), 300);`);
  const { bridge, done } = makeBridge(fake);
  const first = bridge.run({ prompt: 'a' });
  await assert.rejects(bridge.run({ prompt: 'b' }), /already in progress/);
  await first;
  await done();
  await bridge.run({ prompt: 'c' }); // slot freed
  bridge.killAll();
});

test('bridge stop terminates the child', async () => {
  const fake = script('hang.js', `console.log('{"type":"system"}'); setInterval(()=>{}, 1000);`);
  const { bridge, events, done } = makeBridge(fake);
  const { runId } = await bridge.run({ prompt: 'a' });
  for (let i = 0; i < 100 && !events.length; i++) await new Promise((r) => setTimeout(r, 20));
  bridge.stop(runId);
  const all = await done();
  const last = all.at(-1)?.event;
  assert.equal(last?.type, 'done');
  assert.notEqual(last?.code, 0); // killed by signal: null code
});

test('bridge stop escalates to SIGKILL when SIGTERM is ignored', async () => {
  const fake = script('stubborn.js', `process.on('SIGTERM',()=>{}); console.log('{"type":"system"}'); setInterval(()=>{}, 1000);`);
  const { bridge, events, done } = makeBridge(fake, { killGraceMs: 200 });
  const { runId } = await bridge.run({ prompt: 'a' });
  for (let i = 0; i < 100 && !events.length; i++) await new Promise((r) => setTimeout(r, 20));
  bridge.stop(runId);
  await done();
  assert.equal(bridge.running, false);
});

test('spawn failure -> stderr event and done -1', async () => {
  const { bridge, done } = makeBridge(path.join(tmp, 'does-not-exist'));
  await bridge.run({ prompt: 'a' });
  const events = await done();
  assert.equal(events.at(-2)?.event.type, 'stderr');
  assert.deepEqual(events.at(-1)?.event, { type: 'done', code: -1 });
  assert.equal(bridge.running, false);
});

test('run rejects when the binary is missing or the input is invalid, freeing the slot', async () => {
  const { bridge } = makeBridge(null);
  await assert.rejects(bridge.run({ prompt: 'a' }), /not found/);
  await assert.rejects(bridge.run({ prompt: '' }), /prompt/);
  assert.equal(bridge.running, false);
});

// ---- status

const fakeCli = (name: string, version: string, auth: string) =>
  script(name, `
const a = process.argv.slice(2);
if (a[0] === '--version') console.log(${JSON.stringify(version)});
else if (a[0] === 'auth') { ${auth} }
else process.exit(2);`);

test('status parsing helpers', () => {
  assert.equal(parseVersion('2.1.311 (Claude Code)'), '2.1.311');
  assert.equal(parseVersion('nope'), null);
  assert.ok(compareVersions('2.1.0', '2.0.0') > 0 && compareVersions('1.9.9', '2.0.0') < 0 && compareVersions('2.0.0', '2.0.0') === 0);
});

test('status: ready (label has no email), signed_out, too_old, not_found', async () => {
  const ready = fakeCli('s-ready.js', '2.1.311 (Claude Code)',
    `console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'a@b.c',orgName:'Org',subscriptionType:'pro'}))`);
  const s = await checkStatus(ready);
  assert.deepEqual(s, { state: 'ready', version: '2.1.311', account: 'claude.ai pro' });
  assert.ok(!JSON.stringify(s).includes('@'));

  const out = fakeCli('s-out.js', '2.1.311 (Claude Code)', `console.log(JSON.stringify({loggedIn:false})); process.exit(1)`);
  assert.deepEqual(await checkStatus(out), { state: 'signed_out', version: '2.1.311' });

  const garbage = fakeCli('s-garbage.js', '2.1.311', `console.log('Not logged in'); process.exit(1)`);
  assert.deepEqual(await checkStatus(garbage), { state: 'signed_out', version: '2.1.311' });

  const old = fakeCli('s-old.js', '1.0.5 (Claude Code)', `console.log('{"loggedIn":true}')`);
  assert.deepEqual(await checkStatus(old), { state: 'too_old', version: '1.0.5', minimum: '2.0.0' });

  assert.deepEqual(await checkStatus(null), { state: 'not_found' });
  assert.deepEqual(await checkStatus(path.join(tmp, 'missing')), { state: 'not_found' });
  const broken = script('s-broken.js', `process.exit(1)`);
  assert.deepEqual(await checkStatus(broken), { state: 'not_found' });
});

test('status: a hung CLI times out instead of hanging', async () => {
  const hung = script('s-hung.js', `setInterval(()=>{},1000)`);
  assert.deepEqual(await checkStatus(hung, { versionTimeoutMs: 200 }), { state: 'not_found' });
  const hungAuth = script('s-hung-auth.js', `if (process.argv[2]==='--version') console.log('2.1.0'); else setInterval(()=>{},1000)`);
  assert.deepEqual(await checkStatus(hungAuth, { authTimeoutMs: 200 }), { state: 'signed_out', version: '2.1.0' });
});

// ---- locate

test('locate order: env > saved > login shell > fallbacks', async () => {
  const settingsFile = path.join(tmp, 'settings.json');
  const saved = script('saved-claude', '');
  const shellBin = script('shell-claude', '');
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const platform = 'darwin' as const; // POSIX order; the Windows order is covered by claude-windows.test.ts
  const shellResolve = async () => shellBin;
  assert.equal(await locateClaude({ envBin: '/env/claude', settingsFile, shellResolve, home, platform }), '/env/claude');
  assert.equal(await locateClaude({ envBin: null, settingsFile, shellResolve, home, platform }), shellBin);
  saveBin(settingsFile, saved);
  assert.equal(readSavedBin(settingsFile), saved);
  if (posixMode) assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
  assert.equal(await locateClaude({ envBin: null, settingsFile, shellResolve, home, platform }), saved);
  fs.rmSync(saved);
  assert.equal(await locateClaude({ envBin: null, settingsFile, shellResolve, home, platform }), shellBin);
  fs.mkdirSync(path.join(home, '.claude', 'local'), { recursive: true });
  const local = path.join(home, '.claude', 'local', 'claude');
  fs.writeFileSync(local, '');
  fs.chmodSync(local, 0o755);
  assert.equal(await locateClaude({ envBin: null, settingsFile, shellResolve: async () => null, home, platform }), local);
  const none = await locateClaude({
    envBin: null, settingsFile, shellResolve: async () => null, home: path.join(tmp, 'nohome'), isExecutable: () => false, platform,
  });
  assert.equal(none, null);
});
