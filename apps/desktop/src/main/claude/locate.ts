import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LocateDeps {
  /** CLAUDE_BIN from the environment. */
  envBin: string | null;
  /** userData settings JSON (`{ "claudeBin": "..." }`). */
  settingsFile: string;
  /** Resolves `claude` from the login shell; null when unavailable. */
  shellResolve: () => Promise<string | null>;
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Windows: the lines `where.exe claude` prints. */
  whereResolve?: () => Promise<string[]>;
  isExecutable?: (file: string) => boolean;
}

export function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function readSavedBin(settingsFile: string): string | null {
  try {
    const v = (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { claudeBin?: unknown }).claudeBin;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

export function saveBin(settingsFile: string, bin: string): void {
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (parsed && typeof parsed === 'object') current = parsed as Record<string, unknown>;
  } catch {
    // no settings yet
  }
  fs.writeFileSync(settingsFile, JSON.stringify({ ...current, claudeBin: bin }), { mode: 0o600 });
}

/** `$SHELL -ilc 'command -v claude'`: Finder-launched apps do not inherit the shell PATH. */
export function resolveViaLoginShell(shell = process.env.SHELL, timeoutMs = 5000): Promise<string | null> {
  if (!shell || process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', 'command -v claude'], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null);
      // Interactive shells may print banners: take the last line that looks like an absolute path.
      const line = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')).pop();
      resolve(line ?? null);
    });
  });
}

/** `where.exe claude`: every match, one per line. */
export function resolveViaWhere(timeoutMs = 5000): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('where.exe', ['claude'], { timeout: timeoutMs, encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      resolve(err ? [] : whereLines(stdout));
    });
  });
}

export function whereLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** From `where` output: a .exe first, then .cmd/.bat. Extensionless npm shims (sh scripts) are not runnable. */
export function pickWindowsMatch(lines: string[], ok: (f: string) => boolean): string | null {
  const by = (...exts: string[]) =>
    lines.find((l) => exts.includes(path.win32.extname(l).toLowerCase()) && ok(l));
  return by('.exe') ?? by('.cmd', '.bat') ?? null;
}

async function locateWindows(deps: LocateDeps, ok: (f: string) => boolean): Promise<string | null> {
  const env = deps.env ?? process.env;
  const found = pickWindowsMatch(await (deps.whereResolve ?? resolveViaWhere)(), ok);
  if (found) return found;
  const profile = env.USERPROFILE || deps.home || os.homedir();
  const candidates = [path.win32.join(profile, '.local', 'bin', 'claude.exe')];
  if (env.APPDATA) candidates.push(path.win32.join(env.APPDATA, 'npm', 'claude.cmd'));
  if (env.LOCALAPPDATA) candidates.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
  return candidates.find((c) => ok(c)) ?? null;
}

/**
 * CLAUDE_BIN > saved choice > login shell (macOS/Linux) or `where.exe` (Windows) > common install paths.
 * Null when nothing is found.
 */
export async function locateClaude(deps: LocateDeps): Promise<string | null> {
  const ok = deps.isExecutable ?? isExecutableFile;
  if (deps.envBin) return deps.envBin;
  const saved = readSavedBin(deps.settingsFile);
  if (saved && ok(saved)) return saved;
  if ((deps.platform ?? process.platform) === 'win32') return locateWindows(deps, ok);
  const shellBin = await deps.shellResolve();
  if (shellBin && ok(shellBin)) return shellBin;
  const home = deps.home ?? os.homedir();
  const candidates = [
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  return candidates.find((c) => ok(c)) ?? null;
}
