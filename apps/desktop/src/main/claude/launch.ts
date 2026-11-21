import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Launch {
  command: string;
  /** Goes before the claude argv. */
  prefixArgs: string[];
  /** Added to the child's environment (merged over process.env by the caller). */
  env: Record<string, string>;
}

export interface LaunchDeps {
  platform?: NodeJS.Platform;
  /** Electron's own binary, which runs the shim's JS entry when ELECTRON_RUN_AS_NODE=1. */
  execPath?: string;
  readFile?: (file: string) => string;
  exists?: (file: string) => boolean;
}

/**
 * Since Node 18.20.2 spawning a .cmd/.bat without `shell: true` throws EINVAL, and `shell: true` would hand the prompt
 * to cmd.exe. So an npm shim is never run: its JS entry (or the native exe it wraps) is read out of the shim and run
 * directly. Throws a clear Error when the shim is not recognised.
 */
export function resolveLaunch(bin: string, deps: LaunchDeps = {}): Launch {
  const platform = deps.platform ?? process.platform;
  const direct: Launch = { command: bin, prefixArgs: [], env: {} };
  if (platform !== 'win32') return direct;
  const ext = path.win32.extname(bin).toLowerCase();
  const exists = deps.exists ?? ((f: string) => fs.existsSync(f));
  const nodeLaunch = (js: string): Launch => ({
    command: deps.execPath ?? process.execPath,
    prefixArgs: [js],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return nodeLaunch(bin);
  if (ext !== '.cmd' && ext !== '.bat') return direct;

  let text: string;
  try {
    text = (deps.readFile ?? ((f: string) => fs.readFileSync(f, 'utf8')))(bin);
  } catch (e) {
    throw new Error(`Could not read ${bin}: ${(e as Error).message}`);
  }
  const dir = path.win32.dirname(bin);
  // Quoted targets relative to the shim's folder: "%dp0%\node_modules\...\cli.js" or "%~dp0\...\claude.exe".
  const re = /"(?:%~?dp0%?)[\\/]*([^"%]+?\.(?:c?m?js|exe))"/gi;
  const targets: string[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) targets.push(path.win32.join(dir, m[1] ?? ''));
  const target = targets.reverse().find((t) => exists(t));
  if (!target) {
    throw new Error(`Could not work out what ${bin} runs. Choose claude.exe instead (the native installer puts it in %USERPROFILE%\\.local\\bin).`);
  }
  return path.win32.extname(target).toLowerCase() === '.exe' ? { command: target, prefixArgs: [], env: {} } : nodeLaunch(target);
}

export interface KillDeps {
  platform?: NodeJS.Platform;
  /** `taskkill` runner (execFile, no shell). */
  taskkill?: (args: string[]) => void;
}

export function taskkillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/T', '/F'];
}

/** True when the process-tree kill should be used instead of a signal. */
export function useTreeKill(platform: NodeJS.Platform, pid: number | undefined): pid is number {
  return platform === 'win32' && typeof pid === 'number' && pid > 0;
}

/** Stops the child and (on Windows) the processes it spawned. Never throws. */
export function killChild(
  child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals,
  deps: KillDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  try {
    if (useTreeKill(platform, child.pid)) {
      const run = deps.taskkill ?? ((args: string[]) => {
        execFile('taskkill', args, { windowsHide: true }, () => undefined);
      });
      run(taskkillArgs(child.pid));
      return;
    }
    child.kill(signal);
  } catch {
    // already gone, or taskkill missing: the close event still reports
    try {
      child.kill(signal);
    } catch {
      // nothing more to do
    }
  }
}
