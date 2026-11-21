/**
 * Builds the `POST /api/metrics/ingest` body from a `DeviceRead`, mirroring `apps/mobile/src/connect/logic.ts`
 * (`checkForm` with source "device" + `postsToIngest`). That file imports the app's http client, so it is mirrored here.
 */
import type { DeviceRead } from '@/src/desktop/types';
import type { IngestAccount, IngestPost, IngestRequest, ScreenshotPost } from '@/src/types';

export const MAX_HANDLE = 100;
/** Same ceiling as the API's `Count`. */
export const MAX_COUNT = 10 ** 12;
export const MAX_READ_POSTS = 20;

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const count = (n: number): number => Math.min(MAX_COUNT, Math.max(0, Math.round(n)));
const cleanHandle = (raw: string): string => raw.trim().replace(/\s+/g, '').replace(/^@+/, '').slice(0, MAX_HANDLE);

function engagementsOf(p: ScreenshotPost): number | null {
  const parts = [p.likes, p.comments, p.shares].filter(isNum);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

export function postsToIngest(posts: readonly ScreenshotPost[] | null | undefined): IngestPost[] {
  const out: IngestPost[] = [];
  for (const p of posts ?? []) {
    const content = (p.content ?? '').trim();
    const eng = engagementsOf(p);
    const views = isNum(p.views) ? p.views : null;
    if (!content || (views === null && eng === null)) continue;
    out.push({ content, posted_at: p.posted_at ?? null, views: count(views ?? 0), engagements: count(eng ?? 0) });
    if (out.length >= MAX_READ_POSTS) break;
  }
  return out;
}

/** null when the read has no account number at all (nothing worth saving). */
export function buildIngestRequest(read: DeviceRead): IngestRequest | null {
  const account: IngestAccount = {};
  let windowed = false;
  const fields: Array<[keyof IngestAccount, number | null | undefined, boolean]> = [
    ['followers', read.followers, false],
    ['views', read.views, true],
    ['engagements', read.engagements, true],
    ['profile_views', read.profile_views, true],
  ];
  let given = 0;
  for (const [key, value, isWindow] of fields) {
    if (!isNum(value)) continue;
    account[key] = count(value);
    given += 1;
    if (isWindow) windowed = true;
  }
  if (given === 0) return null;
  const handle = cleanHandle(read.handle ?? '');
  return {
    platform: read.platform,
    source: 'device',
    ...(handle ? { handle } : {}),
    ...(windowed && read.period_days ? { period_days: read.period_days } : {}),
    account,
    posts: postsToIngest(read.posts),
  };
}

/** The numbers Claude is told about (no post text). */
export function summarizeRead(read: DeviceRead): Record<string, unknown> {
  return {
    platform: read.platform,
    handle: read.handle ?? null,
    followers: read.followers ?? null,
    views: read.views ?? null,
    engagements: read.engagements ?? null,
    profile_views: read.profile_views ?? null,
    period_days: read.period_days ?? null,
    posts_read: read.posts?.length ?? 0,
  };
}
