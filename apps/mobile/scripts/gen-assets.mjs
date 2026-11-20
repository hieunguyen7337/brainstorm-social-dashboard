#!/usr/bin/env node
/**
 * Pulse brand assets: app icon, adaptive icon, splash, favicons, PWA icons and public/manifest.json.
 *
 *   cd apps/mobile && node scripts/gen-assets.mjs        (or: npm run gen:assets)
 *
 * Dependency-free (node:zlib, node:fs, node:path, node:url only). The mark is a rounded-square badge with a diagonal
 * violet -> pink gradient and a white ECG "pulse" line. It is drawn by a tiny software rasteriser (signed-distance
 * fields + 4x4 supersampling) and encoded to PNG by hand (scanline filters + zlib + CRC32). Output is deterministic, so
 * re-running leaves git clean. Fully opaque images are written as RGB (no alpha channel, which the App Store
 * requires of the iOS icon); the rest are 8-bit RGBA.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // apps/mobile

// ---------------------------------------------------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------------------------------------------------
const APP_NAME = process.env.APP_NAME || process.env.EXPO_PUBLIC_APP_NAME || 'Pulse';
const NAVY = '#0b1020';
const VIOLET = [0x7c, 0x5c, 0xff]; // #7c5cff, top-left
const PINK = [0xff, 0x5c, 0x8a]; // #ff5c8a, bottom-right
const CORNER = 0.225; // badge corner radius, as a fraction of the badge side
const STROKE = 0.07; // pulse line width, as a fraction of the badge side
const STROKE_SMALL = 0.088; // a little bolder for the tiny favicons so the line survives 16px
const SAFE_RADIUS = 0.4; // maskable icons: all content inside a circle of 80% of the canvas

/**
 * The pulse line in badge units (0..1, y down): flat, small bump, tall spike up, spike down, flat.
 * The bump is a raised cosine so it leaves and rejoins the flat line smoothly; the spikes stay sharp.
 */
const PULSE = (() => {
  const base = 0.52;
  const pts = [
    [0.17, base],
    [0.26, base],
  ];
  const bump = { from: 0.26, to: 0.4, height: 0.095, steps: 12 };
  for (let i = 1; i < bump.steps; i++) {
    const t = i / bump.steps;
    pts.push([bump.from + (bump.to - bump.from) * t, base - (bump.height * (1 - Math.cos(2 * Math.PI * t))) / 2]);
  }
  pts.push([bump.to, base], [0.455, base], [0.55, 0.22], [0.64, 0.79], [0.705, base], [0.83, base]);
  return pts;
})();

/** Farthest reach of the stroked line from the badge centre, in badge units. */
function glyphReach(stroke) {
  let far = 0;
  for (const [u, v] of PULSE) far = Math.max(far, Math.hypot(u - 0.5, v - 0.5));
  return far + stroke / 2;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rasteriser: signed distance fields, 4x4 supersampling
// ---------------------------------------------------------------------------------------------------------------------
const SS = 4; // samples per pixel axis
const SW = 1 / SS; // one sample is SW pixels wide: the antialiasing ramp of each sample's coverage

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded square centred at (cx, cy) with half-side `half` and corner radius `rad`. */
function sdRoundBox(x, y, cx, cy, half, rad) {
  const qx = Math.abs(x - cx) - (half - rad);
  const qy = Math.abs(y - cy) - (half - rad);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - rad;
}

/**
 * Signed distance to a polyline stroked with round caps and joins (a union of capsules): returns a function of (x, y)
 * that is negative inside the stroke. Also exposes the padded bounding box so callers can skip far-away pixels.
 */
function makeStroke(points, radius) {
  const n = points.length - 1;
  const seg = new Float64Array(n * 5); // ax, ay, dx, dy, 1 / |d|^2
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    seg.set([ax, ay, dx, dy, 1 / (dx * dx + dy * dy)], i * 5);
    x0 = Math.min(x0, ax, bx);
    y0 = Math.min(y0, ay, by);
    x1 = Math.max(x1, ax, bx);
    y1 = Math.max(y1, ay, by);
  }
  const pad = radius + 2;
  const box = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  const distance = (x, y) => {
    let best = Infinity;
    for (let i = 0; i < n * 5; i += 5) {
      const px = x - seg[i];
      const py = y - seg[i + 1];
      const h = clamp01((px * seg[i + 2] + py * seg[i + 3]) * seg[i + 4]);
      const ex = px - seg[i + 2] * h;
      const ey = py - seg[i + 3] * h;
      best = Math.min(best, ex * ex + ey * ey);
    }
    return Math.sqrt(best) - radius;
  };
  return { box, distance };
}

/**
 * Draws the mark into an RGBA buffer.
 *  - bleed: the gradient fills the whole canvas (no transparency); otherwise a rounded badge `scale` * size wide sits
 *    centred on a transparent canvas.
 *  - stroke: pulse line width as a fraction of the badge side.
 */
function renderMark(size, { bleed = false, scale = 1, stroke = STROKE } = {}) {
  const side = bleed ? size : size * scale;
  const origin = (size - side) / 2; // badge top-left (same on both axes)
  const centre = size / 2;
  const halfSide = side / 2;
  const cornerRadius = side * CORNER;

  const points = PULSE.map(([u, v]) => [origin + u * side, origin + v * side]);
  const glyph = makeStroke(points, (side * stroke) / 2);
  const inGlyphBox = (x, y) => x > glyph.box.x0 && x < glyph.box.x1 && y > glyph.box.y0 && y < glyph.box.y1;
  const badge = bleed ? () => -1e9 : (x, y) => sdRoundBox(x, y, centre, centre, halfSide, cornerRadius);

  /** Diagonal gradient parameter: 0 at the badge's top-left corner, 1 at its bottom-right (CSS 135deg). */
  const gradientAt = (x, y) => clamp01((x - origin + (y - origin)) / (2 * side));

  const out = new Uint8Array(size * size * 4);
  // Premultiplied accumulators for the pixel being shaded.
  let accR = 0;
  let accG = 0;
  let accB = 0;
  let accA = 0;

  /** Adds one sample (weight w): white glyph over the gradient badge, each with SDF coverage. */
  const sample = (x, y, w) => {
    const cover = clamp01(0.5 - badge(x, y) / SW);
    if (cover === 0) return; // outside the badge (the glyph never leaves it)
    const t = gradientAt(x, y);
    const g = inGlyphBox(x, y) ? clamp01(0.5 - glyph.distance(x, y) / SW) : 0;
    const k = cover * (1 - g);
    accR += w * (255 * g + mix(VIOLET[0], PINK[0], t) * k);
    accG += w * (255 * g + mix(VIOLET[1], PINK[1], t) * k);
    accB += w * (255 * g + mix(VIOLET[2], PINK[2], t) * k);
    accA += w * (g + k);
  };

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      accR = accG = accB = accA = 0;
      const cx = i + 0.5;
      const cy = j + 0.5;
      const db = badge(cx, cy);
      const dg = inGlyphBox(cx, cy) ? glyph.distance(cx, cy) : 1e9;
      if (Math.abs(db) > 1 && Math.abs(dg) > 1) {
        // Further than a pixel from every edge: all 16 samples would agree, so shade the centre once.
        sample(cx, cy, 1);
      } else {
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) sample(i + (sx + 0.5) * SW, j + (sy + 0.5) * SW, 1 / (SS * SS));
        }
      }
      const o = (j * size + i) * 4;
      if (accA > 0) {
        out[o] = Math.round(accR / accA);
        out[o + 1] = Math.round(accG / accA);
        out[o + 2] = Math.round(accB / accA);
        out[o + 3] = Math.round(accA * 255);
      } else {
        // Fully transparent: still store the gradient colour, so resamplers that ignore alpha do not fringe dark.
        const t = gradientAt(cx, cy);
        out[o] = Math.round(mix(VIOLET[0], PINK[0], t));
        out[o + 1] = Math.round(mix(VIOLET[1], PINK[1], t));
        out[o + 2] = Math.round(mix(VIOLET[2], PINK[2], t));
        out[o + 3] = 0;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// PNG encoder: CRC32, adaptive scanline filters, zlib
// ---------------------------------------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const head = Buffer.alloc(4);
  const tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Applies the PNG filter (None, Sub, Up, Average, Paeth) that minimises the sum of absolute residuals, per row. */
function filterScanlines(pixels, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const zero = new Uint8Array(stride);
  const trial = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const dst = trial[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[i] - pred) & 0xff;
        dst[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    out.set(trial[best], y * (stride + 1) + 1);
  }
  return out;
}

/** Encodes RGBA pixels as a PNG; drops the alpha channel (colour type 2) when every pixel is fully opaque. */
function encodePng(width, height, rgba) {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  let pixels = rgba;
  if (opaque) {
    pixels = new Uint8Array(width * height * 3);
    for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
      pixels[o] = rgba[i];
      pixels[o + 1] = rgba[i + 1];
      pixels[o + 2] = rgba[i + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // colour type: RGB / RGBA (compression, filter and interlace stay 0)
  const idat = deflateSync(filterScanlines(pixels, width, height, opaque ? 3 : 4), { level: 9 });
  return {
    opaque,
    data: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', idat),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------------------------------
/**
 * bleed: full-bleed gradient (opaque). Otherwise a rounded badge `scale` wide on transparent.
 * safe: maskable icon, so the line must stay inside a centred circle of this radius (as a fraction of the canvas).
 */
const OUTPUTS = [
  // Expo config: icon (iOS applies its own corner mask), android.adaptiveIcon.foregroundImage (the Android safe zone
  // is the middle ~61% of the 108dp layer, the background colour is navy), splash plugin image, web.favicon.
  { file: 'assets/icon.png', size: 1024, bleed: true },
  { file: 'assets/adaptive-icon.png', size: 1024, scale: 0.62 },
  { file: 'assets/splash-icon.png', size: 1024, scale: 0.6 },
  { file: 'assets/favicon.png', size: 96, scale: 0.96, stroke: STROKE_SMALL },
  // Web (PWA): linked from public/manifest.json and app/+html.tsx.
  { file: 'public/icon-192.png', size: 192, bleed: true, safe: SAFE_RADIUS },
  { file: 'public/icon-512.png', size: 512, bleed: true, safe: SAFE_RADIUS },
  { file: 'public/apple-touch-icon.png', size: 180, bleed: true },
  { file: 'public/favicon.png', size: 64, scale: 0.96, stroke: STROKE_SMALL },
];

function writeFile(rel, data) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return path;
}

for (const { file, size, safe, ...style } of OUTPUTS) {
  if (safe !== undefined && glyphReach(style.stroke ?? STROKE) > safe) {
    throw new Error(`${file}: the pulse line leaves the maskable safe zone (reach ${glyphReach(style.stroke ?? STROKE).toFixed(3)} > ${safe})`);
  }
  const started = Date.now();
  const { data, opaque } = encodePng(size, size, renderMark(size, style));
  const path = writeFile(file, data);
  const kb = (data.length / 1024).toFixed(1).padStart(6);
  console.log(`${relative(ROOT, path).padEnd(30)} ${`${size}x${size}`.padEnd(10)} ${opaque ? 'RGB ' : 'RGBA'} ${kb} KB  ${Date.now() - started} ms`);
}

// Web app manifest: public/ is copied verbatim into the web export (served at /manifest.json).
const manifest = {
  name: APP_NAME,
  short_name: APP_NAME,
  description: 'Automated social media manager',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: NAVY,
  theme_color: NAVY,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
console.log(relative(ROOT, writeFile('public/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)));
