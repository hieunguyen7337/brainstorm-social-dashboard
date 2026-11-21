import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killChild, resolveLaunch, taskkillArgs } from '../src/main/claude/launch.ts';
import { locateClaude, pickWindowsMatch, whereLines } from '../src/main/claude/locate.ts';
import { ClaudeBridge } from '../src/main/claude/bridge.ts';

const NPM_JS_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;
const NPM_EXE_SHIM = `@ECHO off
SET dp0=%~dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;
const SHIM = 'C:\\Users\\Me\\AppData\\Roaming\\npm\\claude.cmd';
const W = (...p: string[]) => path.win32.join('C:\\Users\\Me\\AppData\\Roaming\\npm', ...p);

test('resolveLaunch: non-Windows and .exe run directly', () => {
  assert.deepEqual(resolveLaunch('/usr/local/bin/claude', { platform: 'darwin' }), { command: '/usr/local/bin/claude', prefixArgs: [], env: {} });
  assert.deepEqual(resolveLaunch('C:\\x\\claude.exe', { platform: 'win32' }), { command: 'C:\\x\\claude.exe', prefixArgs: [], env: {} });
});

test('resolveLaunch: npm .cmd -> cli.js through ELECTRON_RUN_AS_NODE, never the .cmd', () => {
  const cli = W('node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const l = resolveLaunch(SHIM, {
    platform: 'win32', execPath: 'C:\\Pulse\\Pulse.exe', readFile: () => NPM_JS_SHIM, exists: (f) => f === cli,
  });
  assert.deepEqual(l, { command: 'C:\\Pulse\\Pulse.exe', prefixArgs: [cli], env: { ELECTRON_RUN_AS_NODE: '1' } });
});

test('resolveLaunch: .cmd wrapping a native exe spawns the exe', () => {
  const exe = W('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const l = resolveLaunch(SHIM, { platform: 'win32', readFile: () => NPM_EXE_SHIM, exists: (f) => f === exe });
  assert.deepEqual(l, { command: exe, prefixArgs: [], env: {} });
});

test('resolveLaunch: unknown or dangling .cmd gives a clear error', () => {
  assert.throws(
    () => resolveLaunch(SHIM, { platform: 'win32', readFile: () => '@echo hi\r\n', exists: () => true }),
    /Could not work out what .*claude\.cmd runs/,
  );
  assert.throws(
    () => resolveLaunch(SHIM, { platform: 'win32', readFile: () => NPM_JS_SHIM, exists: () => false }),
    /Choose claude\.exe/,
  );
  assert.throws(
    () => resolveLaunch(SHIM, { platform: 'win32', readFile: () => { throw new Error('ENOENT'); } }),
    /Could not read/,
  );
});

test('where.exe parsing prefers .exe, then .cmd, skips extensionless shims', () => {
  const lines = whereLines('C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n\r\nC:\\bin\\claude.exe\r\n');
  assert.equal(pickWindowsMatch(lines, () => true), 'C:\\bin\\claude.exe');
  assert.equal(pickWindowsMatch(lines.slice(0, 2), () => true), 'C:\\npm\\claude.cmd');
  assert.equal(pickWindowsMatch(lines.slice(0, 1), () => true), null);
});

test('locate on win32: env > saved > where > native > npm > LOCALAPPDATA', async () => {
  const env = { USERPROFILE: 'C:\\Users\\Me', APPDATA: 'C:\\Users\\Me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Me\\AppData\\Local' };
  const native = 'C:\\Users\\Me\\.local\\bin\\claude.exe';
  const npm = 'C:\\Users\\Me\\AppData\\Roaming\\npm\\claude.cmd';
  const local = 'C:\\Users\\Me\\AppData\\Local\\Programs\\claude\\claude.exe';
  const base = {
    envBin: null, settingsFile: 'C:\\nope\\settings.json', platform: 'win32' as const, env,
    shellResolve: async () => { throw new Error('login shell must not run on Windows'); },
    whereResolve: async () => [] as string[],
  };
  assert.equal(await locateClaude({ ...base, envBin: 'D:\\c.exe' }), 'D:\\c.exe');
  assert.equal(await locateClaude({ ...base, whereResolve: async () => ['C:\\npm\\claude', 'C:\\npm\\claude.cmd', 'C:\\w\\claude.exe'], isExecutable: () => true }), 'C:\\w\\claude.exe');
  const only = (...files: string[]) => (f: string) => files.includes(f);
  assert.equal(await locateClaude({ ...base, isExecutable: only(native, npm, local) }), native);
  assert.equal(await locateClaude({ ...base, isExecutable: only(npm, local) }), npm);
  assert.equal(await locateClaude({ ...base, isExecutable: only(local) }), local);
  assert.equal(await locateClaude({ ...base, isExecutable: () => false }), null);
});

test('killChild: taskkill /T /F on win32, signal elsewhere, never throws', () => {
  const calls: string[] = [];
  const child = { pid: 4242, kill: (s?: NodeJS.Signals) => { calls.push(`kill ${s}`); return true; } };
  const tk: string[][] = [];
  killChild(child, 'SIGTERM', { platform: 'win32', taskkill: (a) => tk.push(a) });
  assert.deepEqual(tk, [taskkillArgs(4242)]);
  assert.deepEqual(taskkillArgs(4242), ['/pid', '4242', '/T', '/F']);
  assert.deepEqual(calls, []);
  killChild(child, 'SIGKILL', { platform: 'darwin', taskkill: (a) => tk.push(a) });
  assert.deepEqual(calls, ['kill SIGKILL']);
  // taskkill failing falls back to kill(); a throwing kill() is swallowed
  const bad = { pid: 1, kill: () => { throw new Error('gone'); } };
  killChild(bad, 'SIGKILL', { platform: 'win32', taskkill: () => { throw new Error('no taskkill'); } });
  killChild({ kill: bad.kill }, 'SIGKILL', { platform: 'win32' });
});

test('bridge on win32 stops through taskkill and survives the escalation', async () => {
  const tk: string[][] = [];
  const events: string[] = [];
  const hang = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-win-')), 'hang.js');
  fs.writeFileSync(hang, 'console.log("{}"); setInterval(() => {}, 1000);');
  const bridge = new ClaudeBridge({
    resolveBin: async () => process.execPath,
    resolveLaunch: () => ({ command: process.execPath, prefixArgs: [hang], env: {} }),
    writeMcpConfig: () => '/x/mcp.json',
    workDir: process.cwd(),
    send: (_id, e) => events.push(e.type),
    killGraceMs: 50,
    kill: { platform: 'win32', taskkill: (a) => tk.push(a) },
  });
  const { runId } = await bridge.run({ prompt: 'a' });
  for (let i = 0; i < 100 && !events.length; i++) await new Promise((r) => setTimeout(r, 20));
  bridge.stop(runId);
  await new Promise((r) => setTimeout(r, 200)); // grace elapses: second taskkill, no throw
  assert.equal(tk.length, 2);
  assert.ok(tk.every((a) => a[2] === '/T' && a[3] === '/F'));
  bridge.killAll(); // the fake taskkill killed nothing; stop the real child
  process.kill(Number(tk[0]?.[1]), 'SIGKILL');
});
