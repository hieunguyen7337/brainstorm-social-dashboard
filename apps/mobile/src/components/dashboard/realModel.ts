/** Pure helpers for the Dashboard of a real workspace (docs/REAL.md): which view to show, and the per-platform followers. */
import { isConnected } from '@/src/connect';
import type { AsyncState } from '@/src/hooks';
import { LIVE_PLATFORMS } from '@/src/platforms';
import { type Connection, type Platform, type PlatformStats } from '@/src/types';

/**
 * What the Dashboard shows, decided by the connections request:
 *  - 'sample'     an old sample workspace: the dashboard renders exactly as it always did.
 *  - 'loading'    real workspace, connections not known yet: keep the skeleton (never flash charts or the call to action).
 *  - 'empty'      connections loaded and none is connected: one call to action instead of numbers and charts.
 *  - 'connected'  at least one connected account: the person's real numbers.
 *  - 'unknown'    the request failed and there is nothing to go on: fall back to the normal dashboard.
 */
export type DashMode = 'sample' | 'loading' | 'empty' | 'connected' | 'unknown';

export function dashMode(real: boolean, connections: Pick<AsyncState<Connection[]>, 'data' | 'error'>): DashMode {
  if (!real) return 'sample';
  const list = connections.data;
  // `data` rather than `loading`: `loading` is false for a render before the loader's first request starts.
  if (!Array.isArray(list)) return connections.error ? 'unknown' : 'loading';
  return list.some((c) => isConnected(c)) ? 'connected' : 'empty';
}

export interface FollowerChip {
  platform: Platform;
  followers: number;
}

/**
 * Followers per platform for the Followers tile: only platforms with followers above 0, biggest first. Takes the
 * dashboard's `by_platform[i].followers` and falls back to the connection's own count when the summary does not carry it.
 * `only` is the platform filter on screen: the tile then shows that platform alone.
 */
export function followerChips(
  byPlatform: readonly PlatformStats[] | undefined,
  connections: readonly Connection[] | undefined,
  only: Platform | null = null,
): FollowerChip[] {
  const chips: FollowerChip[] = [];
  for (const platform of LIVE_PLATFORMS) {
    if (only && platform !== only) continue;
    const row = Array.isArray(byPlatform) ? byPlatform.find((p) => p.platform === platform) : undefined;
    const conn = Array.isArray(connections) ? connections.find((c) => c.platform === platform) : undefined;
    const raw = typeof row?.followers === 'number' ? row.followers : isConnected(conn) ? conn.followers : 0;
    const followers = Number.isFinite(raw) ? Math.round(raw) : 0;
    if (followers > 0) chips.push({ platform, followers });
  }
  // Array.prototype.sort is stable, so equal counts keep the platform order.
  return chips.sort((a, b) => b.followers - a.followers);
}

/** "3 platforms" / "1 platform". */
export const platformsLabel = (n: number): string => `${n} ${n === 1 ? 'platform' : 'platforms'}`;
