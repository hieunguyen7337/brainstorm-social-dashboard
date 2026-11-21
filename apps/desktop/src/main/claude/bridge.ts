import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ClaudeEvent } from '@/src/desktop/types';
import { buildArgs, validateRun } from './args.ts';
import { killChild, resolveLaunch } from './launch.ts';
import type { KillDeps, Launch } from './launch.ts';

export function lineSplitter(onLine: (line: string) => void) {
  let buf = '';
  return {
    push(chunk: string): void {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    },
    flush(): void {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

export interface BridgeDeps {
  /** Resolves the binary (null: not found). */
  resolveBin: () => Promise<string | null>;
  /** Writes the MCP config for this run and returns its path. */
  writeMcpConfig: () => string;
  workDir: string;
  send: (runId: string, event: ClaudeEvent) => void;
  killGraceMs?: number;
  /** Test seams. */
  resolveLaunch?: (bin: string) => Launch;
  kill?: KillDeps;
}

export class ClaudeBridge {
  private active: { runId: string; child: ChildProcess | null; killTimer?: NodeJS.Timeout } | null = null;

  private deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  async run(input: unknown): Promise<{ runId: string }> {
    const req = validateRun(input);
    if (this.active) throw new Error('A run is already in progress');
    const runId = randomUUID();
    const slot: NonNullable<ClaudeBridge['active']> = { runId, child: null };
    this.active = slot; // claim before awaiting so a second run is rejected
    try {
      const bin = await this.deps.resolveBin();
      if (!bin) throw new Error('Claude Code was not found');
      const args = buildArgs(req, this.deps.writeMcpConfig());
      this.start(slot, (this.deps.resolveLaunch ?? resolveLaunch)(bin), args);
    } catch (e) {
      this.active = null;
      throw e;
    }
    return { runId };
  }

  private start(slot: NonNullable<ClaudeBridge['active']>, launch: Launch, args: string[]): void {
    const { runId } = slot;
    const send = (event: ClaudeEvent) => this.deps.send(runId, event);
    let child: ChildProcess;
    let finished = false;
    const finish = (code: number | null, message?: string) => {
      if (finished) return;
      finished = true;
      out.flush();
      err.flush();
      if (message) send({ type: 'stderr', line: message });
      send({ type: 'done', code });
      if (slot.killTimer) clearTimeout(slot.killTimer);
      if (this.active === slot) this.active = null;
    };
    const out = lineSplitter((line) => {
      try {
        send({ type: 'json', data: JSON.parse(line) });
      } catch {
        send({ type: 'stderr', line });
      }
    });
    const err = lineSplitter((line) => send({ type: 'stderr', line }));
    try {
      child = spawn(launch.command, [...launch.prefixArgs, ...args], {
        cwd: this.deps.workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...launch.env },
        windowsHide: true,
      });
    } catch (e) {
      // Give the renderer time to subscribe before the failure arrives.
      setTimeout(() => finish(-1, `spawn failed: ${(e as Error).message}`), 50);
      return;
    }
    slot.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => out.push(c));
    child.stderr?.on('data', (c: string) => err.push(c));
    let failed = false;
    child.on('error', (e) => {
      failed = true;
      setTimeout(() => finish(-1, `spawn failed: ${e.message}`), 50);
    });
    child.on('close', (code) => {
      if (!failed) finish(code); // after a spawn error, `close` follows with a bogus code: the error path reports
    });
  }

  /** SIGTERM, then SIGKILL (Windows: taskkill /T /F on the process tree) after the grace period. Unknown run ids are ignored. */
  stop(runId: unknown): void {
    const slot = this.active;
    if (!slot || slot.runId !== runId || !slot.child || slot.killTimer) return;
    const child = slot.child;
    killChild(child, 'SIGTERM', this.deps.kill);
    slot.killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killChild(child, 'SIGKILL', this.deps.kill);
    }, this.deps.killGraceMs ?? 3000);
    slot.killTimer.unref();
  }

  /** App quit: no events, no waiting. */
  killAll(): void {
    const child = this.active?.child;
    if (child && child.exitCode === null && child.signalCode === null) killChild(child, 'SIGKILL', this.deps.kill);
  }

  get running(): boolean {
    return this.active !== null;
  }
}
