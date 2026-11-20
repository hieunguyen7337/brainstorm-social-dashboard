/** Pure geometry and colour helpers for the chart components (no React, no react-native). */

export interface Pt {
  x: number;
  y: number;
}

export const TWO_PI = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A finite number, or 0: a NaN or Infinity must never reach an SVG path string. */
export const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Two decimals max, so path strings stay short. */
const n2 = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * Smooth monotone-cubic path through `pts` (x strictly increasing). Same maths as d3's curveMonotoneX
 * (Steffen slopes), so the curve never overshoots the data: peaks stay peaks, flat runs stay flat.
 */
export function monotonePath(pts: Pt[]): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${n2(pts[0].x)} ${n2(pts[0].y)}`;
  if (n === 2) return `M${n2(pts[0].x)} ${n2(pts[0].y)}L${n2(pts[1].x)} ${n2(pts[1].y)}`;

  const dx = (i: number): number => pts[i + 1].x - pts[i].x;
  const secant = (i: number): number => {
    const h = dx(i);
    return h === 0 ? 0 : (pts[i + 1].y - pts[i].y) / h;
  };

  // Tangent slope at every point.
  const m = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const h0 = dx(i - 1);
    const h1 = dx(i);
    const s0 = secant(i - 1);
    const s1 = secant(i);
    const p = (s0 * h1 + s1 * h0) / (h0 + h1 || 1);
    m[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  m[0] = (3 * secant(0) - m[1]) / 2;
  m[n - 1] = (3 * secant(n - 2) - m[n - 2]) / 2;

  let d = `M${n2(pts[0].x)} ${n2(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const h = (b.x - a.x) / 3;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    // Clamping the control points to the segment's y-range guarantees no overshoot, even at the end points.
    const y1 = clamp(a.y + h * m[i], lo, hi);
    const y2 = clamp(b.y - h * m[i + 1], lo, hi);
    d += `C${n2(a.x + h)} ${n2(y1)} ${n2(b.x - h)} ${n2(y2)} ${n2(b.x)} ${n2(b.y)}`;
  }
  return d;
}

/** Close a line path down to `baseY` so it can be filled. */
export function areaPath(line: string, first: Pt, last: Pt, baseY: number): string {
  return `${line}L${n2(last.x)} ${n2(baseY)}L${n2(first.x)} ${n2(baseY)}Z`;
}

/**
 * Circular arc on a circle of radius `r`, from angle `a0` to `a1` (radians, 0 = 12 o'clock, clockwise).
 * A full turn is drawn as two half arcs because a single SVG arc cannot start and end on the same point.
 */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const pt = (a: number): string => `${n2(cx + r * Math.sin(a))} ${n2(cy - r * Math.cos(a))}`;
  const rr = n2(r);
  const sweep = a1 - a0;
  if (sweep >= TWO_PI - 1e-4) {
    return `M${pt(a0)}A${rr} ${rr} 0 0 1 ${pt(a0 + Math.PI)}A${rr} ${rr} 0 0 1 ${pt(a0 + TWO_PI)}`;
  }
  return `M${pt(a0)}A${rr} ${rr} 0 ${sweep > Math.PI ? 1 : 0} 1 ${pt(a1)}`;
}

/** Closed polygon with every corner rounded by up to `radius` (quadratic corners). */
export function roundedPolygon(pts: Pt[], radius: number): string {
  const n = pts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i + n - 1) % n];
    const next = pts[(i + 1) % n];
    const lp = Math.hypot(prev.x - p.x, prev.y - p.y) || 1;
    const ln = Math.hypot(next.x - p.x, next.y - p.y) || 1;
    const r = Math.min(radius, lp / 2, ln / 2);
    const ax = p.x + ((prev.x - p.x) / lp) * r;
    const ay = p.y + ((prev.y - p.y) / lp) * r;
    const bx = p.x + ((next.x - p.x) / ln) * r;
    const by = p.y + ((next.y - p.y) / ln) * r;
    d += `${i === 0 ? 'M' : 'L'}${n2(ax)} ${n2(ay)}Q${n2(p.x)} ${n2(p.y)} ${n2(bx)} ${n2(by)}`;
  }
  return `${d}Z`;
}

/**
 * Round axis ticks from 0 to just above `max`: 0, 5k, 10k, 15k. Always starts at 0. Counts never get a
 * fractional step (the compact formatter would print duplicate labels), an all-zero chart gets 0..3.
 */
export function niceTicks(max: number, intervals = 3): { ticks: number[]; top: number } {
  if (!(max > 0)) return { ticks: [0, 1, 2, 3], top: 3 };
  const rough = max / intervals;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const f = rough / pow;
  let step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
  if (max >= 1) step = Math.max(1, step);
  const count = Math.max(1, Math.ceil(max / step - 1e-9));
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) ticks.push(i * step);
  return { ticks, top: count * step };
}

const HEX = /^#?([0-9a-f]{6})$/i;

/** Mix two `#rrggbb` colours (t = 0 gives `a`, 1 gives `b`). Non-hex input falls back to `a`. */
export function lerpColor(a: string, b: string, t: number): string {
  const ma = HEX.exec(a.trim());
  const mb = HEX.exec(b.trim());
  if (!ma || !mb) return a;
  const na = parseInt(ma[1], 16);
  const nb = parseInt(mb[1], 16);
  const k = clamp(t, 0, 1);
  const ch = (shift: number): string => {
    const va = (na >> shift) & 255;
    const vb = (nb >> shift) & 255;
    return Math.round(va + (vb - va) * k)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/** 0.4123 -> "41%", 0.032 -> "3.2%", 0.004 -> "<1%". */
export function pctText(share: number): string {
  const p = share * 100;
  if (!(p > 0)) return '0%';
  if (p < 1) return '<1%';
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}
