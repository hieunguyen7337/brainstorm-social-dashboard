// Metro config for the Pulse app: Expo defaults plus one web-only size optimisation.
//
// WHY: the web export is served without compression and `@expo/vector-icons` ships whole icon families:
//   - glyph maps (JSON, name -> code point) are bundled into the JS: MaterialCommunityIcons alone is 185 KB of JS
//     for the two arrows RedditPreview uses; FontAwesome6 adds 75 KB, Ionicons 30 KB. All of it lands in the
//     entry/common chunks that every first load must download.
//   - the fonts are 390 KB (Ionicons), 209 KB (FA6 brands), 424 KB (FA6 solid), 68 KB (FA6 regular), 1.3 MB (MCI),
//     fetched by the first icon that mounts.
// WHAT: for production web builds only, every glyph map and icon font is replaced by a copy that contains just the
// icons the app source mentions (a string literal equal to a glyph name, anywhere under app/ and src/). The
// components, glyph names and code points are unchanged, so the rendered icons are identical. Dev (`expo start`),
// native builds and tests keep the full files.
//
// SAFETY: a name built at runtime (template literal) cannot be seen by the scan, so if the source looks like it does
// that, or anything in the subsetting fails, the build quietly keeps the full files. Opt out: PULSE_ICON_SUBSET=0.
// Generated files live in node_modules/pulse-icon-subsets (never committed; rebuilt on every Metro start).
const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const ICONS = path.join(
  __dirname,
  'node_modules',
  '@expo',
  'vector-icons',
  'build',
  'vendor',
  'react-native-vector-icons',
);
const OUT = path.join(__dirname, 'node_modules', 'pulse-icon-subsets');

/** family -> its glyph map file(s) and font file(s) (paths relative to ICONS). */
const FAMILIES = {
  Ionicons: { maps: ['Ionicons.json'], fonts: ['Ionicons.ttf'] },
  MaterialCommunityIcons: { maps: ['MaterialCommunityIcons.json'], fonts: ['MaterialCommunityIcons.ttf'] },
  FontAwesome6: {
    maps: ['FontAwesome6Free.json', 'FontAwesome6Free_meta.json'],
    fonts: ['FontAwesome6_Brands.ttf', 'FontAwesome6_Regular.ttf', 'FontAwesome6_Solid.ttf'],
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Which icon names does the app use?
// ---------------------------------------------------------------------------------------------------------------

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Every quoted token in app/ and src/ (superset of icon names), or null when icon names might be built at runtime. */
function scanUsedTokens() {
  const tokens = new Set();
  const re = /(['"`])([A-Za-z0-9][A-Za-z0-9-]*)\1/g;
  // A template literal or a cast in an icon name position, or direct use of a glyph map: names we cannot see.
  const dynamic = /\bname=\{\s*`|\bicon\w*\s*[:=]\s*`|\bas\s+IconName\b|\bglyphMap\b|getRawGlyphMap|\bhasIcon\b/;
  for (const root of ['app', 'src']) {
    const dir = path.join(__dirname, root);
    if (!fs.existsSync(dir)) continue;
    for (const f of sourceFiles(dir)) {
      const text = fs.readFileSync(f, 'utf8');
      if (dynamic.test(text)) return null;
      for (const m of text.matchAll(re)) tokens.add(m[2]);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------------
// Minimal TrueType (glyf) subsetter: keeps the requested code points, renumbers glyphs, rewrites the tables that
// depend on glyph ids. Throws on anything unexpected (composite glyphs, no usable cmap) so the caller can fall back.
// ---------------------------------------------------------------------------------------------------------------

function readFont(buf) {
  const u16 = (o) => buf.readUInt16BE(o);
  const i16 = (o) => buf.readInt16BE(o);
  const u32 = (o) => buf.readUInt32BE(o);
  if (u32(0) !== 0x00010000) throw new Error('not a TrueType (glyf) font');
  const tables = {};
  for (let i = 0, n = u16(4); i < n; i++) {
    const o = 12 + i * 16;
    tables[buf.toString('latin1', o, o + 4)] = { off: u32(o + 8), len: u32(o + 12) };
  }
  for (const t of ['head', 'maxp', 'hhea', 'hmtx', 'loca', 'glyf', 'cmap']) {
    if (!tables[t]) throw new Error(`missing ${t}`);
  }
  const locFmt = i16(tables.head.off + 50);
  const numGlyphs = u16(tables.maxp.off + 4);
  const numHM = u16(tables.hhea.off + 34);

  // cmap: prefer a full-repertoire format 12 subtable, else a BMP format 4 one.
  const cm = tables.cmap.off;
  const subs = [];
  for (let i = 0, n = u16(cm + 2); i < n; i++) {
    const p = u16(cm + 4 + i * 8);
    const e = u16(cm + 6 + i * 8);
    const off = cm + u32(cm + 8 + i * 8);
    subs.push({ p, e, off, fmt: u16(off) });
  }
  const sub =
    subs.find((s) => s.p === 3 && s.e === 10 && s.fmt === 12) ||
    subs.find((s) => s.p === 0 && s.e === 4 && s.fmt === 12) ||
    subs.find((s) => s.p === 3 && s.e === 1 && s.fmt === 4) ||
    subs.find((s) => s.p === 0 && s.fmt === 4);
  if (!sub) throw new Error('no usable cmap subtable');

  function lookup(cp) {
    const o = sub.off;
    if (sub.fmt === 12) {
      for (let g = 0, n = u32(o + 12), p = o + 16; g < n; g++, p += 12) {
        const start = u32(p);
        const end = u32(p + 4);
        if (cp >= start && cp <= end) return u32(p + 8) + (cp - start);
      }
      return 0;
    }
    if (cp > 0xffff) return 0;
    const segX2 = u16(o + 6);
    const endO = o + 14;
    const startO = endO + segX2 + 2;
    const deltaO = startO + segX2;
    const rangeO = deltaO + segX2;
    for (let s = 0; s < segX2; s += 2) {
      if (cp > u16(endO + s)) continue;
      if (cp < u16(startO + s)) return 0;
      const ro = u16(rangeO + s);
      if (ro === 0) return (cp + u16(deltaO + s)) & 0xffff;
      const g = u16(rangeO + s + ro + (cp - u16(startO + s)) * 2);
      return g === 0 ? 0 : (g + u16(deltaO + s)) & 0xffff;
    }
    return 0;
  }

  const locaAt = (g) => (locFmt ? u32(tables.loca.off + 4 * g) : 2 * u16(tables.loca.off + 2 * g));
  function glyph(g) {
    const a = locaAt(g);
    const b = locaAt(g + 1);
    return buf.subarray(tables.glyf.off + a, tables.glyf.off + b);
  }
  function metrics(g) {
    const m = tables.hmtx.off;
    return g < numHM
      ? { aw: u16(m + 4 * g), lsb: i16(m + 4 * g + 2) }
      : { aw: u16(m + 4 * (numHM - 1)), lsb: i16(m + 4 * numHM + 2 * (g - numHM)) };
  }
  return { buf, tables, numGlyphs, lookup, glyph, metrics };
}

function checksum(b) {
  let sum = 0;
  const padded = b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function cmapTable(entries /* [cp, gid] sorted by cp */) {
  // format 12 groups
  const groups = [];
  for (const [cp, gid] of entries) {
    const last = groups[groups.length - 1];
    if (last && cp === last[1] + 1 && gid === last[2] + (cp - last[0])) last[1] = cp;
    else groups.push([cp, cp, gid]);
  }
  const f12 = Buffer.alloc(16 + groups.length * 12);
  f12.writeUInt16BE(12, 0);
  f12.writeUInt32BE(f12.length, 4);
  f12.writeUInt32BE(groups.length, 12);
  groups.forEach((g, i) => {
    f12.writeUInt32BE(g[0], 16 + i * 12);
    f12.writeUInt32BE(g[1], 20 + i * 12);
    f12.writeUInt32BE(g[2], 24 + i * 12);
  });
  const bmp = entries.every(([cp]) => cp <= 0xfffe);
  let f4 = null;
  if (bmp) {
    const segs = groups.map((g) => [g[0], g[1], (g[2] - g[0]) & 0xffff]);
    segs.push([0xffff, 0xffff, 1]);
    const n = segs.length;
    f4 = Buffer.alloc(16 + n * 8);
    f4.writeUInt16BE(4, 0);
    f4.writeUInt16BE(f4.length, 2);
    f4.writeUInt16BE(n * 2, 6);
    const es = Math.floor(Math.log2(n));
    f4.writeUInt16BE(2 * 2 ** es, 8);
    f4.writeUInt16BE(es, 10);
    f4.writeUInt16BE(n * 2 - 2 * 2 ** es, 12);
    segs.forEach((s, i) => {
      f4.writeUInt16BE(s[1], 14 + i * 2); // endCode
      f4.writeUInt16BE(s[0], 16 + n * 2 + i * 2); // startCode (after 2 bytes reservedPad)
      f4.writeUInt16BE(s[2], 16 + n * 4 + i * 2); // idDelta
      // idRangeOffset stays 0
    });
  }
  const records = [];
  if (f4) records.push([0, 3, 'f4']);
  records.push([0, 4, 'f12']);
  if (f4) records.push([3, 1, 'f4']);
  records.push([3, 10, 'f12']);
  const headLen = 4 + records.length * 8;
  const f4Off = headLen;
  const f12Off = headLen + (f4 ? f4.length : 0);
  const head = Buffer.alloc(headLen);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(records.length, 2);
  records.forEach(([p, e, k], i) => {
    head.writeUInt16BE(p, 4 + i * 8);
    head.writeUInt16BE(e, 6 + i * 8);
    head.writeUInt32BE(k === 'f4' ? f4Off : f12Off, 8 + i * 8);
  });
  return Buffer.concat([head, f4 || Buffer.alloc(0), f12]);
}

function subsetFont(buf, codePoints) {
  const font = readFont(buf);
  const t = font.tables;
  const cpGid = new Map();
  for (const cp of codePoints) {
    const g = font.lookup(cp);
    if (g > 0 && g < font.numGlyphs) cpGid.set(cp, g);
  }
  const oldIds = [0, ...new Set(cpGid.values())].sort((a, b) => a - b);
  const newId = new Map(oldIds.map((g, i) => [g, i]));
  const k = oldIds.length;

  const glyfParts = [];
  const loca = Buffer.alloc((k + 1) * 4);
  const hmtx = Buffer.alloc(k * 4);
  let pos = 0;
  oldIds.forEach((g, i) => {
    const data = font.glyph(g);
    if (data.length && data.readInt16BE(0) < 0) throw new Error('composite glyph');
    loca.writeUInt32BE(pos, i * 4);
    const pad = (4 - (data.length % 4)) % 4;
    glyfParts.push(data, Buffer.alloc(pad));
    pos += data.length + pad;
    const m = font.metrics(g);
    hmtx.writeUInt16BE(m.aw, i * 4);
    hmtx.writeInt16BE(m.lsb, i * 4 + 2);
  });
  loca.writeUInt32BE(pos, k * 4);

  const copy = (tag) => Buffer.from(buf.subarray(t[tag].off, t[tag].off + t[tag].len));
  const head = copy('head');
  head.writeUInt32BE(0, 8); // checkSumAdjustment, set below
  head.writeInt16BE(1, 50); // long loca
  const hhea = copy('hhea');
  hhea.writeUInt16BE(k, 34);
  const maxp = copy('maxp');
  maxp.writeUInt16BE(k, 4);
  // post: version 3 (no glyph names), keep the 16 bytes of metrics from the original header
  const post = Buffer.alloc(32);
  if (t.post) buf.copy(post, 4, t.post.off + 4, t.post.off + 16);
  post.writeUInt32BE(0x00030000, 0);

  const out = {
    head,
    hhea,
    maxp,
    hmtx,
    loca,
    glyf: Buffer.concat(glyfParts),
    cmap: cmapTable([...cpGid].map(([cp, g]) => [cp, newId.get(g)]).sort((a, b) => a[0] - b[0])),
    post,
  };
  for (const tag of ['OS/2', 'name', 'cvt ', 'fpgm', 'prep', 'gasp']) if (t[tag]) out[tag] = copy(tag);

  const tags = Object.keys(out).sort();
  const n = tags.length;
  const es = Math.floor(Math.log2(n));
  const header = Buffer.alloc(12 + n * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(16 * 2 ** es, 6);
  header.writeUInt16BE(es, 8);
  header.writeUInt16BE(n * 16 - 16 * 2 ** es, 10);
  let off = header.length;
  const bodies = [];
  tags.forEach((tag, i) => {
    const b = out[tag];
    header.write(tag, 12 + i * 16, 'latin1');
    header.writeUInt32BE(checksum(b), 16 + i * 16);
    header.writeUInt32BE(off, 20 + i * 16);
    header.writeUInt32BE(b.length, 24 + i * 16);
    const pad = (4 - (b.length % 4)) % 4;
    bodies.push(b, Buffer.alloc(pad));
    off += b.length + pad;
  });
  const file = Buffer.concat([header, ...bodies]);
  const headOff = header.readUInt32BE(20 + tags.indexOf('head') * 16);
  file.writeUInt32BE((0xb1b0afba - checksum(file)) >>> 0, headOff + 8);

  // Verify: every kept code point resolves to a glyph with byte-identical outline data.
  const check = readFont(file);
  for (const [cp, g] of cpGid) {
    const ng = check.lookup(cp);
    if (!ng || !check.glyph(ng).equals(font.glyph(g))) {
      throw new Error(`subset verification failed for U+${cp.toString(16)}`);
    }
  }
  return { file, glyphs: cpGid.size };
}

// ---------------------------------------------------------------------------------------------------------------
// Generate the subset files once per Metro start (production only).
// ---------------------------------------------------------------------------------------------------------------

function writeIfChanged(file, data) {
  try {
    if (fs.readFileSync(file).equals(Buffer.isBuffer(data) ? data : Buffer.from(data))) return;
  } catch {}
  const tmp = `${file}.${process.pid}.tmp`; // atomic: concurrent builds write identical content
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function generateSubsets() {
  const used = scanUsedTokens();
  if (!used) {
    console.warn('[pulse-perf] icon names may be built at runtime: keeping the full icon fonts and glyph maps');
    return null;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const files = new Map(); // original basename -> generated absolute path
  const report = [];
  for (const [family, spec] of Object.entries(FAMILIES)) {
    const names = new Map(); // glyph name -> code point
    for (const m of spec.maps) {
      const json = JSON.parse(fs.readFileSync(path.join(ICONS, 'glyphmaps', m), 'utf8'));
      if (m.endsWith('_meta.json')) {
        const pruned = {};
        for (const [style, list] of Object.entries(json)) pruned[style] = list.filter((n) => used.has(n));
        writeIfChanged(path.join(OUT, m), JSON.stringify(pruned));
      } else {
        const pruned = {};
        for (const [name, cp] of Object.entries(json)) {
          if (!used.has(name)) continue;
          pruned[name] = cp;
          names.set(name, cp);
        }
        writeIfChanged(path.join(OUT, m), JSON.stringify(pruned));
      }
      files.set(m, path.join(OUT, m));
    }
    const cps = [...new Set(names.values())];
    for (const f of spec.fonts) {
      const original = fs.readFileSync(path.join(ICONS, 'Fonts', f));
      const { file, glyphs } = subsetFont(original, cps);
      writeIfChanged(path.join(OUT, f), file);
      files.set(f, path.join(OUT, f));
      const kb = (n) => (n / 1024).toFixed(1);
      report.push(`${f.replace('.ttf', '')} ${glyphs}g ${kb(file.length)}K (was ${kb(original.length)}K)`);
    }
  }
  console.log(`[pulse-perf] web icon subsets: ${report.join(', ')}`);
  return files;
}

let subsets = null;
if (process.env.NODE_ENV === 'production' && process.env.PULSE_ICON_SUBSET !== '0') {
  try {
    subsets = generateSubsets();
  } catch (e) {
    console.warn(`[pulse-perf] icon subsetting skipped: ${e.message}`);
    subsets = null;
  }
}

if (subsets) {
  const upstream = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const fromIcons = platform === 'web' && /@expo[\\/]vector-icons/.test(context.originModulePath);
    const replacement = fromIcons && /\.(json|ttf)$/.test(moduleName) && subsets.get(path.basename(moduleName));
    if (replacement) {
      return moduleName.endsWith('.json')
        ? { type: 'sourceFile', filePath: replacement }
        : { type: 'assetFiles', filePaths: [replacement] };
    }
    return (upstream || context.resolveRequest)(context, moduleName, platform);
  };
}

module.exports = config;
