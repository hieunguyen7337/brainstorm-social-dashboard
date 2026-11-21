/**
 * Autopilot logic with no React and no react-native imports: interval presets, the status-line maths, platform
 * helpers and the autosave engine (`ConfigSaver`). `autopilot-state.tsx` wires it to React.
 */
import { parseTs, timeAgo } from '@/src/format';
import { LIVE_PLATFORMS } from '@/src/platforms';
import { type AutopilotConfig, type Connection, type Platform } from '@/src/types';

/** The fields the user edits; `last_run_at` belongs to the server. */
export type Editable = Pick<AutopilotConfig, 'enabled' | 'interval_min' | 'platforms' | 'require_approval'>;
/** Local edits the server has not confirmed yet; shown on top of the server config. */
export type Overlay = Partial<Editable>;

export const MIN_INTERVAL = 1;
export const MAX_INTERVAL = 1440;
/** Quiet time after the last keystroke before a typed value is saved. */
export const DEBOUNCE_MS = 500;

export const INTERVAL_PRESETS: readonly { label: string; minutes: number }[] = [
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 h', minutes: 60 },
  { label: '2 h', minutes: 120 },
  { label: '6 h', minutes: 360 },
  { label: '24 h', minutes: 1440 },
];

export const clampInterval = (n: number): number => Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(n)));

/** 45 -> "45 min", 90 -> "1 h 30 min", 120 -> "2 h". */
export function formatMinutes(total: number): string {
  if (total < 90) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Hero status: "Off", or "On: next run in ~12 min" computed from `last_run_at` + `interval_min`. */
export function statusLine(cfg: Pick<AutopilotConfig, 'enabled' | 'interval_min' | 'last_run_at'>, now: number): string {
  if (!cfg.enabled) return 'Off';
  if (!cfg.last_run_at) return 'On: first run starting shortly';
  const last = parseTs(cfg.last_run_at).getTime();
  if (Number.isNaN(last)) return 'On';
  const remaining = last + cfg.interval_min * 60_000 - now;
  if (remaining <= 0) return 'On: next run any moment';
  return `On: next run in ~${formatMinutes(Math.ceil(remaining / 60_000))}`;
}

/** "Last run 5m ago" / "Never run yet". A timestamp a little ahead of this device's clock reads as "just now". */
export function lastRunLine(lastRunAt: string | null, now: number): string {
  if (!lastRunAt) return 'Never run yet';
  const at = parseTs(lastRunAt).getTime();
  if (Number.isNaN(at)) return 'Last run recently';
  return `Last run ${timeAgo(lastRunAt, Math.max(now, at))}`;
}

/** Platforms to switch on when autopilot is enabled with none chosen: the connected ones, else every live one. */
export function defaultPlatforms(connections: readonly Connection[] | undefined): Platform[] {
  const connected = new Set((connections ?? []).filter((c) => c.status === 'connected').map((c) => c.platform));
  const picked = LIVE_PLATFORMS.filter((p) => connected.has(p));
  return picked.length > 0 ? picked : [...LIVE_PLATFORMS];
}

/** The list after tapping `platform`, or null when the tap would clear the last selected platform. */
export function togglePlatform(current: readonly Platform[], platform: Platform): Platform[] | null {
  const has = current.includes(platform);
  if (has && current.length <= 1) return null;
  const next = new Set(current);
  if (has) next.delete(platform);
  else next.add(platform);
  return LIVE_PLATFORMS.filter((p) => next.has(p));
}

const listKey = (list: readonly string[]): string => [...list].sort().join(',');

export const sameEditable = (a: Editable, b: Editable): boolean =>
  a.enabled === b.enabled &&
  a.interval_min === b.interval_min &&
  a.require_approval === b.require_approval &&
  listKey(a.platforms) === listKey(b.platforms);

export interface SaverPorts {
  /** PUT the full config; resolves with what the server stored. */
  put(body: AutopilotConfig): Promise<AutopilotConfig>;
  /** The authoritative config changed (a save or a manual run landed). */
  serverChanged(next: AutopilotConfig): void;
  /** The set of unconfirmed local edits changed. */
  overlayChanged(next: Overlay): void;
  /** A PUT succeeded. */
  saved(): void;
  /** A PUT failed; the local edits were dropped, so the UI falls back to the server config. */
  failed(error: unknown): void;
}

/**
 * Optimistic, coalescing autosave for the autopilot config.
 *
 * - `edit()` records a local change (the "overlay") and schedules a PUT of the full config: at once for taps, after
 *   `debounceMs` of quiet for typing.
 * - One PUT is in flight at a time. Edits made meanwhile fold into a single follow-up PUT, so requests cannot overtake
 *   each other and the server always ends on the latest state.
 * - A failed PUT drops the whole overlay (revert) and reports once; nothing is retried behind the user's back.
 * - While a write is in flight, or finished since a poll started, that poll's answer may predate it: `isStale` tells
 *   the data fetcher to keep what it has rather than roll the UI back.
 */
export class ConfigSaver {
  /** Latest authoritative config. The hook keeps it in step with what `useAsync` holds. */
  server: AutopilotConfig | undefined;

  private readonly ports: SaverPorts;
  private readonly debounceMs: number;
  private overlay: Overlay = {};
  /** Bumped by every edit: tells a finishing PUT whether newer edits arrived while it was in flight. */
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private dirty = false;
  private loop: Promise<void> = Promise.resolve();
  private writes = 0;
  private gen = 0;

  constructor(ports: SaverPorts, debounceMs: number = DEBOUNCE_MS) {
    this.ports = ports;
    this.debounceMs = debounceMs;
  }

  /** Record a local change and schedule the save. Ignored until a config has loaded. */
  edit(change: Overlay, mode: 'now' | 'debounced' = 'now'): void {
    if (!this.server) return;
    this.version += 1;
    this.overlay = { ...this.overlay, ...change };
    this.ports.overlayChanged(this.overlay);
    this.clearTimer();
    if (mode === 'now') {
      void this.flush();
    } else {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.debounceMs);
    }
  }

  /** Save now. Resolves when everything pending has been sent (or has failed). Never rejects. */
  flush(): Promise<void> {
    this.clearTimer();
    if (this.inflight) {
      this.dirty = true;
      return this.loop;
    }
    this.inflight = true;
    this.loop = this.drain();
    return this.loop;
  }

  /** Alias for callers that need "everything the user typed has reached the server" before they go on. */
  settle(): Promise<void> {
    return this.flush();
  }

  /** Unmount: a typed value still waiting on its debounce is sent rather than lost. */
  dispose(): void {
    if (this.timer) void this.flush();
  }

  /** Take the config as it is on the server (after a manual run, say). */
  applyServer(next: AutopilotConfig): void {
    this.server = next;
    this.ports.serverChanged(next);
  }

  /** Run a server mutation that a poll must not race (a manual autopilot cycle). */
  async write<T>(job: () => Promise<T>): Promise<T> {
    this.beginWrite();
    try {
      return await job();
    } finally {
      this.endWrite();
    }
  }

  /** Take before starting a poll request... */
  pollToken(): number {
    return this.gen;
  }

  /** ...and ask once its answer is in: true when a write overlapped it, so the answer may be out of date. */
  isStale(token: number): boolean {
    return this.writes > 0 || this.gen !== token;
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.dirty = false;
        await this.saveOnce();
      } while (this.dirty);
    } finally {
      this.inflight = false;
    }
  }

  private async saveOnce(): Promise<void> {
    const base = this.server;
    const sent = this.overlay;
    if (!base || Object.keys(sent).length === 0) return;
    const body: AutopilotConfig = { ...base, ...sent };
    if (sameEditable(base, body)) {
      // The edits cancelled each other out (toggled on then off) or repeat what the server has.
      this.dropOverlay();
      return;
    }
    const sentVersion = this.version;
    this.beginWrite();
    try {
      const res = await this.ports.put(body);
      const saved: AutopilotConfig = res && typeof res === 'object' ? { ...body, ...res } : body;
      this.server = saved;
      this.ports.serverChanged(saved);
      // Keep the overlay when newer edits arrived mid-flight: they are still waiting for their own PUT.
      if (this.version === sentVersion) this.dropOverlay();
      this.ports.saved();
    } catch (e) {
      this.dirty = false;
      this.dropOverlay();
      this.ports.failed(e);
    } finally {
      this.endWrite();
    }
  }

  private dropOverlay(): void {
    this.overlay = {};
    this.ports.overlayChanged(this.overlay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private beginWrite(): void {
    this.writes += 1;
    this.gen += 1;
  }

  private endWrite(): void {
    this.writes -= 1;
    this.gen += 1;
  }
}
