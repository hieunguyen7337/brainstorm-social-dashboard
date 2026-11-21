/** Split text into plain and http(s) URL parts, so URLs can be rendered as tappable links. */
export type TextPart = { text: string; url?: string };

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
// Characters that end a sentence or close a wrapper, not part of the address.
const TRAIL_RE = /[.,;:!?)\]}>*_]+$/;

export function splitLinks(input: string): TextPart[] {
  const text = input ?? '';
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let url = m[0];
    const trail = TRAIL_RE.exec(url);
    if (trail) url = url.slice(0, url.length - trail[0].length);
    if (!/^https?:\/\/[^/\s]+/i.test(url)) continue;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
