/**
 * Parsers for the in-app "sign in and read my numbers" flow (docs/REAL.md, unit R3).
 *
 * What a signed-in page yielded (innerText or JSON) goes in, a `ParsedRead` comes out. For every parser:
 * - Numbers go through `parseCount`: whole, non-negative, at most 1e12. Anything else is not a number, and a number the
 *   page does not show is left out of the result (the key is omitted). Nothing is ever estimated.
 * - Garbage (null, numbers, arrays, `{}`, huge strings) gives `{}`. Nothing here throws, logs or returns page text: the
 *   only page text that comes back is a handle and the clipped Instagram captions the contract asks for.
 * - Plain functions, erasable TypeScript and a type-only import, so Node can import this file directly.
 * - Every scan is linear in the input, so a 20,000-character page of digits, commas, spaces or newlines is cheap.
 */
import type { ParsedRead, Platform, ReadPost, ScreenshotRead } from './types';

type Obj = Record<string, unknown>;

/** The biggest count taken as real; anything above is a parse accident or a different kind of number. */
const MAX_COUNT = 1e12;
/** A count token ("1,234,567", "12.5K") is never longer than this; longer strings are rejected without a scan. */
const MAX_COUNT_CHARS = 40;
/** The reader scripts cap text at 20,000 characters; this only bounds what a garbage caller can make us scan. */
const MAX_TEXT_CHARS = 200_000;
const MAX_WORDS = 60_000;
/** The ingest endpoint takes handles of at most 100 characters. */
const MAX_HANDLE_CHARS = 100;
const MAX_CAPTION_CHARS = 200;
const MAX_IG_POSTS = 12;
const MAX_IG_EDGES_SCANNED = 60;
/** 9999-12-31T23:59:59Z: the last second `toISOString` writes with a four-digit year. */
const MAX_UNIX_SECONDS = 253_402_300_799;

// ---- small shared helpers -------------------------------------------------------------------------------------------

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `c` is a UTF-16 code unit from `charCodeAt`: true for "0".."9". */
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** `v[k1][k2]...` through plain objects only; undefined as soon as the path leaves them. */
function dig(v: unknown, ...keys: string[]): unknown {
  let cur: unknown = v;
  for (const k of keys) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** The text to scan, or null when `v` is not a string. Only bounds the work; real inputs are far shorter. */
function textOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.length > MAX_TEXT_CHARS ? v.slice(0, MAX_TEXT_CHARS) : v;
}

/** Runs one parser; whatever goes wrong inside, the caller gets `{}` and never an exception. */
function guard(read: () => ParsedRead): ParsedRead {
  try {
    return read();
  } catch {
    return {};
  }
}

type NumberKey = 'followers' | 'following' | 'posts_count' | 'views' | 'engagements' | 'profile_views' | 'period_days';

/** Sets `out[key]` only when a number was found, so "absent on the page" stays an absent key. */
function setNum(out: ParsedRead, key: NumberKey, value: number | null): void {
  if (value !== null) out[key] = value;
}

/** A handle without its leading "@", or null when it is not a plausible one (empty, over 100 chars, any whitespace). */
function cleanHandle(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > MAX_HANDLE_CHARS * 4) return null;
  const t = v.trim();
  let from = 0;
  while (from < t.length && t.charAt(from) === '@') from++;
  const h = t.slice(from);
  if (h.length === 0 || h.length > MAX_HANDLE_CHARS || /\s/.test(h)) return null;
  for (let i = 0; i < h.length; i++) {
    const c = h.charCodeAt(i);
    if (c < 32 || c === 127) return null; // control characters
  }
  return h;
}

/** The count of the first value that is present at all, valid or not: a hidden -1 must not fall through to a fallback. */
function firstPresentCount(...values: unknown[]): number | null {
  for (const v of values) {
    if (v !== undefined && v !== null) return parseCount(v);
  }
  return null;
}

// ---- parseCount: the one number helper ------------------------------------------------------------------------------

/**
 * (int.frac) x 10^exp as a whole number, rounded half up, or null above 1e12. Works on digit strings, so "1.1K" is
 * exactly 1100 and never 1100.0000000000002.
 */
function scaleDigits(int: string, frac: string, exp: number): number | null {
  const digits = int + frac;
  const shift = exp - frac.length;
  let kept: string;
  let roundUp = false;
  if (shift >= 0) {
    kept = digits + '0'.repeat(shift);
  } else {
    const cut = digits.length + shift; // digits before `cut` are whole units, the rest is a fraction
    kept = cut > 0 ? digits.slice(0, cut) : '';
    roundUp = cut >= 0 && cut < digits.length && digits.charCodeAt(cut) >= 53; // first dropped digit is 5..9
  }
  kept = kept.replace(/^0+/, '');
  if (kept.length > 13) return null;
  const n = (kept === '' ? 0 : Number(kept)) + (roundUp ? 1 : 0);
  return n <= MAX_COUNT ? n : null;
}

/** A whole number written without a leading zero ("0" itself is fine). */
function isWhole(digits: string): boolean {
  return digits === '0' || digits.charAt(0) !== '0';
}

/** Thousands grouping: a first group of 1-3 digits (no leading zero), then groups of exactly 3. */
function isGrouped(parts: readonly string[]): boolean {
  const head = parts[0];
  if (head.length < 1 || head.length > 3 || head.charAt(0) === '0') return false;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].length !== 3) return false;
  }
  return true;
}

function countFromString(raw: string): number | null {
  let s = raw.trim();
  if (s.length === 0 || s.length > MAX_COUNT_CHARS) return null;

  // A sentence-ending "." or "," and/or the plus of "10K+" are not part of the number.
  let last = s.charAt(s.length - 1);
  if (last === '.' || last === ',') {
    s = s.slice(0, -1);
    last = s.charAt(s.length - 1);
  }
  if (last === '+') s = s.slice(0, -1);

  // Suffix: exactly one K/M/B in any case, directly after the digits.
  let exp = 0;
  const suffix = s.charAt(s.length - 1);
  if (suffix === 'k' || suffix === 'K') exp = 3;
  else if (suffix === 'm' || suffix === 'M') exp = 6;
  else if (suffix === 'b' || suffix === 'B') exp = 9;
  if (exp > 0) s = s.slice(0, -1);
  if (s.length === 0) return null;

  // Split into digit runs and the separators between them; any other character means this is not a bare count.
  const parts: string[] = [];
  const seps: string[] = [];
  let run = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isDigit(c)) {
      run += s.charAt(i);
    } else if (c === 46 || c === 44 || c === 32 || c === 0xa0 || c === 0x202f) {
      // "." "," space, no-break space (0xa0) and narrow no-break space (0x202f); the last three are plain group spaces
      if (run === '') return null; // leading separator, or two in a row
      parts.push(run);
      seps.push(c === 46 ? '.' : c === 44 ? ',' : ' ');
      run = '';
    } else {
      return null;
    }
  }
  if (run === '') return null; // trailing separator
  parts.push(run);

  if (parts.length === 1) return isWhole(parts[0]) ? scaleDigits(parts[0], '', exp) : null;

  // One kind of separator and a valid grouping: thousands separators ("1,234", "1.234.567", "12 345", "1,234K").
  const sep = seps[0];
  if (seps.every((x) => x === sep) && isGrouped(parts)) return scaleDigits(parts.join(''), '', exp);

  // Otherwise the last separator is a decimal point; only a K/M/B suffix makes that a whole number ("1.5" is null).
  const point = seps[seps.length - 1];
  if (exp === 0 || (point !== '.' && point !== ',')) return null;
  const frac = parts[parts.length - 1];
  const intParts = parts.slice(0, -1);
  if (intParts.length === 1) return isWhole(intParts[0]) ? scaleDigits(intParts[0], frac, exp) : null;
  // "1,234.5K" / "1.234,5K": a grouped integer part whose separator differs from the decimal point.
  const intSeps = seps.slice(0, -1);
  if (intSeps.every((x) => x === intSeps[0]) && intSeps[0] !== point && isGrouped(intParts)) {
    return scaleDigits(intParts.join(''), frac, exp);
  }
  return null;
}

/**
 * A bare count as a page shows it -> a whole number, or null. Never guesses.
 *
 * Numbers: finite and >= 0, rounded. Strings: the whole string must be the count, optionally ending in K/M/B (any
 * case), a "+" ("10K+") and/or a sentence-ending "." or ",". Digit groups may be split by "," "." or a (non-breaking)
 * space. A "." or "," is a decimal point only with a suffix, and only unless exactly three digits follow it (then it
 * is a thousands separator): "1.2K" 1200, "1,2K" 1200, "1,234" 1234, "1,234K" 1234000, "12 345" 12345, "1.5" null.
 * Results above 1e12 are null.
 */
export function parseCount(input: unknown): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) return null;
    const rounded = Math.round(input);
    return rounded <= MAX_COUNT ? rounded + 0 : null; // + 0 turns -0 into 0
  }
  if (typeof input === 'string') return countFromString(input);
  return null;
}

// ---- LinkedIn: innerText of linkedin.com/dashboard ------------------------------------------------------------------

/** Lines of `text`, each with whitespace collapsed, trimmed and lower-cased; empty lines dropped. */
function normalisedLines(text: string): string[] {
  const lines: string[] = [];
  for (const piece of text.split(/\r\n|\n|\r/)) {
    const line = piece.replace(/\s+/g, ' ').trim().toLowerCase();
    if (line !== '') lines.push(line);
  }
  return lines;
}

/**
 * The count for `label` (lower case): on the line BEFORE a line that is exactly the label, or on the same line in front
 * of it ("1,567 post impressions"). The first occurrence that has a count wins; the line after a label is never read.
 */
function countForLabel(lines: readonly string[], label: string): number | null {
  const tail = ` ${label}`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === label) {
      const n = i > 0 ? parseCount(lines[i - 1]) : null;
      if (n !== null) return n;
    } else if (line.length > tail.length && line.endsWith(tail)) {
      const n = parseCount(line.slice(0, line.length - tail.length));
      if (n !== null) return n;
    }
  }
  return null;
}

const DASHBOARD_LABELS = ['post impressions', 'total followers', 'profile viewers', 'search appearances'] as const;

/**
 * The layout check that keeps "number on the line before the label" from reading a label-first page wrongly. In the
 * number-first layout the FIRST dashboard label has its count right before it (same line or previous line). If it does
 * not, the page is label-first (or not the dashboard): with a count under every label, "the line before" would belong to
 * the previous label and every later label would take the wrong number. Read nothing then; the app falls back to a
 * screenshot. No dashboard label at all passes (there is nothing to read).
 */
function firstLabelHasItsCount(lines: readonly string[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const label of DASHBOARD_LABELS) {
      if (line === label) return i > 0 && parseCount(lines[i - 1]) !== null;
      const tail = ` ${label}`;
      if (line.length > tail.length && line.endsWith(tail)) return parseCount(line.slice(0, line.length - tail.length)) !== null;
    }
  }
  return true;
}

/** 1234567 -> "1,234,567" (the count is a whole number <= 1e12, so `String` never uses an exponent). */
function withCommas(n: number): string {
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s.charAt(i);
  }
  return out;
}

function readLinkedIn(input: unknown): ParsedRead {
  const text = textOf(input);
  if (text === null) return {};
  const lines = normalisedLines(text);
  if (!firstLabelHasItsCount(lines)) return {};

  const views = countForLabel(lines, 'post impressions'); // last 7 days
  const followers = countForLabel(lines, 'total followers') ?? countForLabel(lines, 'followers');
  const profileViews = countForLabel(lines, 'profile viewers'); // last 90 days
  const searches = countForLabel(lines, 'search appearances'); // notes only

  const out: ParsedRead = {};
  setNum(out, 'followers', followers);
  setNum(out, 'views', views);
  setNum(out, 'profile_views', profileViews);
  if (views !== null) out.period_days = 7;
  else if (profileViews !== null) out.period_days = 90;

  const sentences: string[] = [];
  if (views !== null && profileViews !== null) {
    sentences.push('Post impressions are for the last 7 days; profile viewers for the last 90 days.');
  } else if (views !== null) {
    sentences.push('Post impressions are for the last 7 days.');
  } else if (profileViews !== null) {
    sentences.push('Profile viewers are for the last 90 days.');
  }
  if (searches !== null) sentences.push(`Search appearances: ${withCommas(searches)}.`);
  if (sentences.length > 0) out.notes = sentences.join(' ');
  return out;
}

/**
 * `document.body.innerText` of linkedin.com/dashboard. The number sits on the line before its label:
 * "Post impressions" -> views (7 days), "Total followers" or "Followers" -> followers, "Profile viewers" ->
 * profile_views (90 days); "Search appearances" is only mentioned in `notes`. A page whose first dashboard label has no
 * count before it (label-first layout) reads as nothing instead of giving every label its neighbour's number.
 */
export function parseLinkedInText(text: string): ParsedRead {
  return guard(() => readLinkedIn(text));
}

// ---- TikTok: __UNIVERSAL_DATA_FOR_REHYDRATION__ or the pruned { userInfo } ------------------------------------------

function isUserInfo(v: unknown): v is Obj {
  return isObj(v) && (isObj(v.user) || isObj(v.stats) || isObj(v.statsV2));
}

/**
 * The `userInfo` object: at its known place in the rehydration JSON, else the shallowest one in a breadth-first search
 * (containers down to depth 6, each visited once so cycles end, with a visit budget so a huge object stays cheap).
 */
function findUserInfo(root: unknown): Obj | null {
  const known = dig(root, '__DEFAULT_SCOPE__', 'webapp.user-detail', 'userInfo');
  if (isUserInfo(known)) return known;

  const seen = new Set<object>();
  let level: unknown[] = [root];
  let budget = 3000;
  for (let depth = 0; depth <= 6 && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (typeof node !== 'object' || node === null || seen.has(node)) continue;
      if (budget-- <= 0) return null;
      seen.add(node);
      if (!Array.isArray(node)) {
        const found = (node as Obj).userInfo;
        if (isUserInfo(found)) return found;
      }
      const kids = Array.isArray(node)
        ? node.slice(0, 50)
        : Object.keys(node)
            .slice(0, 100)
            .map((k) => (node as Obj)[k]);
      for (const kid of kids) {
        if (typeof kid === 'object' && kid !== null && next.length < 5000) next.push(kid);
      }
    }
    level = next;
  }
  return null;
}

function readTikTok(json: unknown): ParsedRead {
  const info = findUserInfo(json);
  if (info === null) return {};
  // `stats` holds numbers, `statsV2` the same as numeric strings; take each value from the first that has it.
  const stat = (key: string): number | null =>
    parseCount(dig(info, 'stats', key)) ?? parseCount(dig(info, 'statsV2', key));

  const out: ParsedRead = {};
  const handle = cleanHandle(dig(info, 'user', 'uniqueId'));
  if (handle !== null) out.handle = handle;
  setNum(out, 'followers', stat('followerCount'));
  setNum(out, 'following', stat('followingCount'));
  setNum(out, 'posts_count', stat('videoCount'));
  const hearts = stat('heartCount'); // lifetime total likes, so no period
  if (hearts !== null) {
    out.engagements = hearts;
    out.notes = 'TikTok total likes (all time).';
  }
  return out;
}

/**
 * The parsed `#__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON, the pruned `{ userInfo: { user: { uniqueId }, stats } }` the
 * page script sends, or anything that contains a `userInfo` object. heartCount (all-time likes) is `engagements`.
 */
export function parseTikTokJson(json: unknown): ParsedRead {
  return guard(() => readTikTok(json));
}

// ---- Instagram: web_profile_info user object ------------------------------------------------------------------------

const INSTAGRAM_USER_KEYS = ['username', 'edge_followed_by', 'edge_follow', 'edge_owner_to_timeline_media'];

/** `{ data: { user: U } }`, `{ user: U }` or `U` itself: the first of these that looks like an Instagram user. */
function findInstagramUser(json: unknown): Obj | null {
  for (const candidate of [dig(json, 'data', 'user'), dig(json, 'user'), json]) {
    if (isObj(candidate) && INSTAGRAM_USER_KEYS.some((k) => k in candidate)) return candidate;
  }
  return null;
}

/** The first 200 characters, without cutting a surrogate pair in half (a lone surrogate breaks JSON/UTF-8 later on). */
function clip(text: string): string {
  if (text.length <= MAX_CAPTION_CHARS) return text;
  const last = text.charCodeAt(MAX_CAPTION_CHARS - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_CAPTION_CHARS - 1 : MAX_CAPTION_CHARS);
}

/** Unix seconds -> "YYYY-MM-DD" (UTC); null for anything that is not a plausible post time. */
function utcDay(seconds: unknown): string | null {
  const s = parseCount(seconds); // also rejects milliseconds (> 1e12) and negatives
  if (s === null || s <= 0 || s > MAX_UNIX_SECONDS) return null;
  return new Date(s * 1000).toISOString().slice(0, 10);
}

function readInstagramPost(node: unknown): ReadPost | null {
  if (!isObj(node)) return null;
  const captions = dig(node, 'edge_media_to_caption', 'edges');
  const text = Array.isArray(captions) ? dig(captions[0], 'node', 'text') : undefined;
  const post: ReadPost = {
    content: typeof text === 'string' && text.trim() !== '' ? clip(text) : null,
    views: node.is_video === true ? parseCount(node.video_view_count) : null,
    likes: firstPresentCount(dig(node, 'edge_liked_by', 'count'), dig(node, 'edge_media_preview_like', 'count')),
    comments: firstPresentCount(
      dig(node, 'edge_media_to_comment', 'count'),
      dig(node, 'edge_media_preview_comment', 'count'),
    ),
    shares: null,
    posted_at: utcDay(node.taken_at_timestamp),
  };
  // A node that gave us nothing at all is not a post: it would make `hasNumbers` true for garbage.
  const empty =
    post.content === null &&
    post.views === null &&
    post.likes === null &&
    post.comments === null &&
    post.posted_at === null;
  return empty ? null : post;
}

function readInstagram(json: unknown): ParsedRead {
  const user = findInstagramUser(json);
  if (user === null) return {};
  const out: ParsedRead = {};
  const handle = cleanHandle(user.username);
  if (handle !== null) out.handle = handle;
  setNum(out, 'followers', parseCount(dig(user, 'edge_followed_by', 'count')));
  setNum(out, 'following', parseCount(dig(user, 'edge_follow', 'count')));
  setNum(out, 'posts_count', parseCount(dig(user, 'edge_owner_to_timeline_media', 'count')));

  const edges = dig(user, 'edge_owner_to_timeline_media', 'edges');
  if (Array.isArray(edges)) {
    const posts: ReadPost[] = [];
    for (let i = 0; i < edges.length && i < MAX_IG_EDGES_SCANNED && posts.length < MAX_IG_POSTS; i++) {
      const post = readInstagramPost(dig(edges[i], 'node'));
      if (post !== null) posts.push(post);
    }
    if (posts.length > 0) out.posts = posts;
  }
  return out;
}

/**
 * `{ user: U }` (what the page script posts), `{ data: { user: U } }` (the raw web_profile_info response) or `U`.
 * Reads the counts plus up to 12 recent posts; a hidden count (-1) is null. There are no account-level views.
 */
export function parseInstagramJson(json: unknown): ParsedRead {
  return guard(() => readInstagram(json));
}

// ---- X and Facebook: "<n> Label" in innerText -----------------------------------------------------------------------

function isAsciiAlnum(c: number): boolean {
  return isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** Digits with "," or "." inside and an optional K/M/B at the end: "46", "1,567", "12.3K", "1.2M". */
function isCountToken(w: string): boolean {
  const n = w.length;
  if (n === 0 || n > MAX_COUNT_CHARS || !isDigit(w.charCodeAt(0))) return false;
  for (let i = 1; i < n; i++) {
    const c = w.charCodeAt(i);
    const isSuffix = c === 75 || c === 77 || c === 66 || c === 107 || c === 109 || c === 98; // K M B k m b
    if (i === n - 1) {
      if (!isDigit(c) && !isSuffix) return false;
    } else if (!isDigit(c) && c !== 46 && c !== 44) {
      return false;
    }
  }
  return true;
}

/** A word as a label: lower case, trailing punctuation dropped ("Followers." -> "followers"); '' when too long. */
function labelWord(w: string): string {
  if (w.length > 16) return '';
  let end = w.length;
  while (end > 0 && !isAsciiAlnum(w.charCodeAt(end - 1))) end--;
  return w.slice(0, end).toLowerCase();
}

/** How many line breaks lie in text[from, to), counting up to 2 (a "\r\n" is one). */
function lineBreaksBetween(text: string, from: number, to: number): number {
  let breaks = 0;
  for (let i = from; i < to && breaks < 2; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) breaks++;
    else if (c === 13 && text.charCodeAt(i + 1) !== 10) breaks++;
  }
  return breaks;
}

/**
 * For each label group (lower-case words, e.g. ['followers', 'follower']), the count of the first "<n> <label>" in
 * `text`, or null. <n> is a count token, the label a whole word in any case, and only whitespace holding at most one
 * line break sits between them, so a bare label (the "Following" tab) takes nothing. With `skipYou`, a "follower(s)"
 * label followed by "you" on the same line ("Followers you know") is not a match. Works word by word, so it is linear
 * however long the runs of digits, commas or spaces are.
 */
function findLabelledCounts(text: string, groups: readonly (readonly string[])[], skipYou: boolean): (number | null)[] {
  const found: (number | null)[] = groups.map(() => null);
  const words: string[] = [];
  const starts: number[] = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m !== null && words.length < MAX_WORDS; m = re.exec(text)) {
    words.push(m[0]);
    starts.push(m.index);
  }

  let open = groups.length;
  for (let i = 1; i < words.length && open > 0; i++) {
    const label = labelWord(words[i]);
    if (label === '') continue;
    const g = groups.findIndex((labels) => labels.includes(label));
    if (g < 0 || found[g] !== null) continue;

    const countWord = words[i - 1];
    if (!isCountToken(countWord)) continue;
    if (lineBreaksBetween(text, starts[i - 1] + countWord.length, starts[i]) > 1) continue;
    if (skipYou && label.startsWith('follower') && i + 1 < words.length) {
      const sameLine = lineBreaksBetween(text, starts[i] + words[i].length, starts[i + 1]) === 0;
      if (sameLine && labelWord(words[i + 1]) === 'you') continue;
    }
    const n = parseCount(countWord);
    if (n === null) continue;
    found[g] = n;
    open--;
  }
  return found;
}

function readX(text: unknown, handle: unknown): ParsedRead {
  const out: ParsedRead = {};
  const h = cleanHandle(handle);
  if (h !== null) out.handle = h;
  const body = textOf(text);
  if (body === null) return out;
  // No posts count: the "<n> posts" line also appears in the sidebar trends, and a trend's count would be taken for the
  // person's own. Followers and following only.
  const [followers, following] = findLabelledCounts(body, [['followers', 'follower'], ['following']], true);
  setNum(out, 'followers', followers);
  setNum(out, 'following', following);
  return out;
}

/**
 * innerText of x.com/<handle>: "<n> Followers" (or "1 Follower") and "<n> Following".
 * `handle` is the account the app signed in with (leading "@" removed); the page text is not searched for it.
 */
export function parseXText(text: string, handle?: string | null): ParsedRead {
  return guard(() => readX(text, handle));
}

function readFacebook(text: unknown): ParsedRead {
  const body = textOf(text);
  if (body === null) return {};
  const [followers, friends] = findLabelledCounts(body, [['followers', 'follower'], ['friends', 'friend']], false);
  const out: ParsedRead = {};
  if (followers !== null) {
    out.followers = followers;
  } else if (friends !== null) {
    out.followers = friends;
    out.notes = 'Facebook showed friends, not followers.';
  }
  return out;
}

/** innerText of m.facebook.com/me: "<n> followers", else "<n> friends" (reported as followers, with a note). */
export function parseFacebookText(text: string): ParsedRead {
  return guard(() => readFacebook(text));
}

// ---- Reddit: /api/me.json and /user/<name>/about.json ---------------------------------------------------------------

/** `{ kind: 't2', data: {...} }` -> the data object (a bare data object is taken as it is); null for anything else. */
function redditData(body: unknown): Obj | null {
  const data = dig(body, 'data');
  if (isObj(data)) return data;
  return isObj(body) ? body : null;
}

/** total_karma, else link_karma + comment_karma when both are there; null otherwise (karma can go negative: null). */
function redditKarma(data: Obj | null): number | null {
  if (data === null) return null;
  const total = parseCount(data.total_karma);
  if (total !== null) return total;
  const link = parseCount(data.link_karma);
  const comment = parseCount(data.comment_karma);
  return link !== null && comment !== null ? parseCount(link + comment) : null;
}

function readReddit(me: unknown, about: unknown): ParsedRead {
  const mine = redditData(me);
  const theirs = redditData(about);
  const out: ParsedRead = {};
  const handle = cleanHandle(mine?.name) ?? cleanHandle(theirs?.name);
  if (handle !== null) out.handle = handle;

  const karma = redditKarma(mine) ?? redditKarma(theirs);
  if (karma !== null) {
    out.engagements = karma;
    out.notes = 'Reddit karma (all time).';
  }
  // A profile's followers are the subscribers of its "u_<name>" subreddit; the public about.json is the better source.
  setNum(
    out,
    'followers',
    parseCount(dig(theirs, 'subreddit', 'subscribers')) ?? parseCount(dig(mine, 'subreddit', 'subscribers')),
  );
  return out;
}

/**
 * `me` is the /api/me.json body, `about` the /user/<name>/about.json body (either may be null, pruned or garbage).
 * engagements is the all-time karma, followers the profile subreddit's subscribers.
 */
export function parseRedditJson(me: unknown, about?: unknown): ParsedRead {
  return guard(() => readReddit(me, about));
}

// ---- result helpers -------------------------------------------------------------------------------------------------

const NUMBER_KEYS = ['followers', 'following', 'posts_count', 'views', 'engagements', 'profile_views'] as const;

/** True when something countable was read: any account number, or at least one post. A handle alone is not numbers. */
export function hasNumbers(p: ParsedRead | null | undefined): boolean {
  if (typeof p !== 'object' || p === null) return false;
  try {
    for (const key of NUMBER_KEYS) {
      const v: unknown = p[key];
      if (typeof v === 'number' && Number.isFinite(v)) return true;
    }
    return Array.isArray(p.posts) && p.posts.length >= 1;
  } catch {
    return false;
  }
}

/** The full `ScreenshotRead` for a parsed read: every gap is `null`, `ai_used` is false, at most 20 posts. */
export function toScreenshotRead(
  platform: Platform,
  p: ParsedRead,
  confidence: 'high' | 'medium' | 'low' = 'high',
): ScreenshotRead {
  const read: ParsedRead = typeof p === 'object' && p !== null ? p : {};
  return {
    platform,
    detected_platform: platform,
    handle: read.handle ?? null,
    followers: read.followers ?? null,
    following: read.following ?? null,
    posts_count: read.posts_count ?? null,
    views: read.views ?? null,
    engagements: read.engagements ?? null,
    profile_views: read.profile_views ?? null,
    period_days: read.period_days ?? null,
    posts: (Array.isArray(read.posts) ? read.posts : []).slice(0, 20),
    confidence,
    notes: read.notes ?? null,
    ai_used: false,
  };
}
