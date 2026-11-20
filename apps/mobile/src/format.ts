/** Formatting helpers shared by every screen. Pure functions, no React. */

/** Timestamps are ISO-8601 UTC. Tolerate a missing zone suffix by treating it as UTC. */
export function parseTs(iso: string): Date {
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(iso);
  const d = new Date(hasZone || !iso.includes('T') ? iso : `${iso}Z`);
  return d;
}

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-AU');

/** 950 -> "950", 12_400 -> "12.4k", 1_250_000 -> "1.25M". */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) {
    const v = n / 1000;
    return `${abs < 10_000 ? v.toFixed(1) : Math.round(v)}k`.replace('.0k', 'k');
  }
  const v = n / 1_000_000;
  return `${abs < 10_000_000 ? v.toFixed(2) : v.toFixed(1)}M`.replace(/\.?0+M$/, 'M');
}

/** 0.0523 -> "5.2%". */
export function fmtPct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Whole-number change: 12 -> "+12%", -4 -> "-4%", 0 -> "0%". */
export function fmtChange(pct: number): string {
  const r = Math.round(pct);
  return `${r > 0 ? '+' : ''}${r}%`;
}

/** "just now", "3m ago", "2h ago", "5d ago", then a short date. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const t = parseTs(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < -60) return `in ${fmtDuration(-s)}`;
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return fmtDay(iso);
}

function fmtDuration(s: number): string {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-20" or a full timestamp -> "20 Nov". */
export function fmtDay(iso: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : parseTs(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Local "Sat 21 Nov, 4:30 pm". */
export function fmtDateTime(iso: string): string {
  const d = parseTs(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${days[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${h}:${mm} ${ampm}`;
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** ["launch", "#cafe"] -> "#launch #cafe". */
export function hashtagsText(tags: string[]): string {
  return tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
}

/** "#a #b, c" -> ["a", "b", "c"] (no leading #, deduped). */
export function parseHashtags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const t = raw.replace(/^#+/, '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** ISO string `hours` from now (for the quick "Schedule" choices). */
export const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

/** Tomorrow at 9:00 local, as ISO UTC. */
export function tomorrowMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}
