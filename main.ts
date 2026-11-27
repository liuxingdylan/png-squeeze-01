// Squeeze — lossless PNG re-encoder for make.fun png-squeeze-01-run-20261127.
//
// One program, one run: reads every /input/<id>/image.png (1280x720 RGBA, 8-bit),
// writes the same pixels back as a much smaller lossless PNG to /output/<id>/image.png.
// No clock reads, no randomness, no network: the same input always yields the same bytes.
//
// How it squeezes:
//  1. Decode the input PNG to raw RGBA with a small self-contained decoder.
//  2. Look at the pixels and pick the cheapest colour representation:
//     palette (<=256 distinct colours), grey, grey+alpha, RGB, or RGBA, and — when every
//     transparent pixel shares one colour that no opaque pixel uses — a tRNS key instead
//     of a full alpha channel.
//  3. For each candidate form, choose a PNG filter per scanline. Candidates: the five
//     fixed filters, plus three adaptive ones — minimum signed-byte sum, fewest distinct
//     adjacent byte pairs, and a brute-force pick that actually trial-deflates each row
//     (zlib level 4, 32 KiB of already-filtered data as dictionary) and keeps the smallest.
//  4. Screen every (form, filter rule) at zlib level 6, keep each form's best, then
//     re-deflate the two best forms at level 9 under three strategies and keep the
//     smallest file. Only IHDR / PLTE / tRNS / IDAT / IEND chunks are written, bit depth 8.
//
// Measured on the kit's practice set (kit scorer): ~705,000 of 1,000,000, vs the house
// baseline fixed-paeth 1.0.0 at ~420,000. A second generated set scores ~708,000.
// Runtime on one CPU is roughly 14-20 s for a set of eight — well inside the 60 s wall.
import { deflateSync, inflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- CRC32 / chunks
const CRC = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function joinParts(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

// ---------------------------------------------------------------- PNG decode
interface Decoded {
  rgba: Uint8Array;
  width: number;
  height: number;
}

function decodePng(bytes: Uint8Array): Decoded {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error('not a PNG');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 12);
    const len = view.getUint32(0);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const ihdr = new DataView(data.buffer, data.byteOffset, 13);
      width = ihdr.getUint32(0);
      height = ihdr.getUint32(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('unsupported PNG (need 8-bit, non-interlaced)');
  const raw = inflateSync(Buffer.concat(idat.map((b) => Buffer.from(b))));
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  if (channels === undefined) throw new Error('unsupported colour type ' + colorType);
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    if (filter > 4) throw new Error('bad filter byte');
    const row = raw.subarray(p, p + stride);
    p += stride;
    const prev = y === 0 ? null : rgba.subarray((y - 1) * width * 4, y * width * 4);
    // Unfilter in place: row[x] becomes the reconstructed sample.
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
      row[x] = v;
    }
    // Expand the row to RGBA, walking backwards so reads stay ahead of writes.
    const out = rgba.subarray(y * width * 4, (y + 1) * width * 4);
    for (let i = width - 1; i >= 0; i--) {
      const s = i * channels;
      const d = i * 4;
      if (colorType === 6) {
        out[d] = row[s];
        out[d + 1] = row[s + 1];
        out[d + 2] = row[s + 2];
        out[d + 3] = row[s + 3];
      } else if (colorType === 2) {
        out[d] = row[s];
        out[d + 1] = row[s + 1];
        out[d + 2] = row[s + 2];
        out[d + 3] = 255;
      } else if (colorType === 0) {
        out[d] = row[s];
        out[d + 1] = row[s];
        out[d + 2] = row[s];
        out[d + 3] = 255;
      } else if (colorType === 4) {
        out[d] = row[s];
        out[d + 1] = row[s];
        out[d + 2] = row[s];
        out[d + 3] = row[s + 1];
      } else {
        const idx = row[s] * 3;
        out[d] = plte![idx];
        out[d + 1] = plte![idx + 1];
        out[d + 2] = plte![idx + 2];
        out[d + 3] = trns && row[s] < trns.length ? trns[row[s]] : 255;
      }
    }
  }
  return { rgba, width, height };
}

// ---------------------------------------------------------------- Image analysis
interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
  word: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null; // null when more than 256 distinct RGBA colours
}

function analyse(rgba: Uint8Array): Analysis {
  const pixels = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, pixels);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let overflow = false;
  for (let i = 0, d = 0; i < pixels; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!overflow) {
      const w = words[i];
      const seen = counts.get(w);
      if (seen === undefined) {
        if (counts.size === 256) overflow = true;
        else counts.set(w, 1);
      } else {
        counts.set(w, seen + 1);
      }
    }
  }
  let colours: Colour[] | null = null;
  if (!overflow) {
    colours = [...counts.entries()].map(([word, count]) => {
      const bytes = new Uint8Array(new Uint32Array([word]).buffer);
      return { r: bytes[0], g: bytes[1], b: bytes[2], a: bytes[3], word, count };
    });
  }
  return { opaque, grey, colours };
}

// Every transparent pixel must share one colour, and no opaque pixel may use it;
// then the image can be written without an alpha channel plus a tRNS key.
// Returns the key as a grey value or a 24-bit RGB value, or null when it does not apply.
function findTransparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] === 255) continue;
    if (rgba[d + 3] !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// ---------------------------------------------------------------- Candidate forms
type FilterRule = number | 'minsum' | 'pairs' | 'brute';

interface Form {
  colorType: number;
  bpp: number;
  samples: Uint8Array; // per-pixel samples in the form's channel layout
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  rules: FilterRule[];
}

function extractSamples(rgba: Uint8Array, colorType: number): Uint8Array {
  const pixels = rgba.length >>> 2;
  if (colorType === 6) return rgba;
  const ch = colorType === 0 ? 1 : colorType === 4 ? 2 : 3;
  const out = new Uint8Array(pixels * ch);
  for (let i = 0, d = 0, s = 0; i < pixels; i++, d += 4, s += ch) {
    if (colorType === 0) {
      out[s] = rgba[d];
    } else if (colorType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteForm(rgba: Uint8Array, colours: Colour[], byLuminance: boolean): Form {
  const lum = (c: Colour): number => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    // Fully transparent colours first (they need tRNS entries), then by rule.
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (byLuminance) return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let lastTransparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) lastTransparent = i + 1;
  });
  const trns =
    lastTransparent === 0
      ? null
      : Uint8Array.from(entries.slice(0, lastTransparent), (c) => c.a);
  const pixels = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, pixels);
  const indices = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) indices[i] = index.get(words[i])!;
  return {
    colorType: 3,
    bpp: 1,
    samples: indices,
    plte,
    trns,
    rules: byLuminance ? [0, 'minsum', 'brute'] : [0],
  };
}

function candidateForms(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, false));
    forms.push(paletteForm(rgba, colours, true));
    if (!grey) return forms; // palette already covers flat-colour RGB; grey still needs grey forms
  }
  const key = opaque ? null : findTransparentKey(rgba, grey);
  let colorType: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    colorType = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    colorType = opaque || key !== null ? 2 : 6;
    if (key !== null) {
      trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
    }
  }
  const bpp = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType]!;
  forms.push({
    colorType,
    bpp,
    samples: extractSamples(rgba, colorType),
    plte: null,
    trns,
    rules: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

// ---------------------------------------------------------------- Filtering
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  for (let x = 0; x < cur.length; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= bpp ? prev[x - bpp] : 0;
    const v = cur[x];
    if (type === 0) out[x] = v;
    else if (type === 1) out[x] = (v - a) & 0xff;
    else if (type === 2) out[x] = (v - b) & 0xff;
    else if (type === 3) out[x] = (v - ((a + b) >> 1)) & 0xff;
    else out[x] = (v - paeth(a, b, c)) & 0xff;
  }
}

function signedByteSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function distinctPairs(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;

function applyRule(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  rule: FilterRule,
): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof rule === 'number') {
      raw[at] = rule;
      filterRow(rule, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trials[t]);
      let cost: number;
      if (rule === 'minsum') {
        cost = signedByteSum(trials[t]);
      } else if (rule === 'pairs') {
        cost = distinctPairs(trials[t], seen, ++stamp);
      } else {
        const rowBytes = Buffer.concat([Buffer.from([t]), Buffer.from(trials[t])]);
        const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
        cost = deflateSync(
          rowBytes,
          before.length === 0
            ? { level: 4, memLevel: 9 }
            : { level: 4, memLevel: 9, dictionary: Buffer.from(before) },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trials[type], at + 1);
  }
  return raw;
}

// ---------------------------------------------------------------- Encoder
function ihdr(width: number, height: number, colorType: number): Uint8Array {
  const d = new Uint8Array(13);
  const view = new DataView(d.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colorType;
  d[10] = 0; // compression
  d[11] = 0; // filter method
  d[12] = 0; // no interlace
  return d;
}

function writePng(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [chunk('IHDR', ihdr(width, height, form.colorType))];
  if (form.plte) parts.push(chunk('PLTE', form.plte));
  if (form.trns) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return joinParts([signature, ...parts]);
}

// Overhead of a form's extra chunks, so forms are compared on total file size.
function extraChunkBytes(form: Form): number {
  return (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);
}

const SCREEN_OPTS = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const FINAL_OPTS = [
  { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
  { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
];

interface Candidate {
  form: Form;
  rule: FilterRule;
  filtered: Uint8Array;
  bytes: number;
}

function encodeImage(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const forms = candidateForms(rgba);
  // Screen every (form, rule) at zlib level 6; keep each form's best filtered data.
  const screened: Candidate[] = [];
  for (const form of forms) {
    let best: Candidate | null = null;
    for (const rule of form.rules) {
      const filtered = applyRule(form.samples, width, height, form.bpp, rule);
      const z = deflateSync(filtered, SCREEN_OPTS);
      const bytes = z.length + extraChunkBytes(form);
      if (!best || bytes < best.bytes) best = { form, rule, filtered, bytes };
    }
    screened.push(best!);
  }
  screened.sort((a, b) => a.bytes - b.bytes);
  // Final: re-deflate the two best candidates at level 9 under three strategies.
  // Each strategy wins on different images, so all three stay in the schedule.
  let winner: { form: Form; bytes: number; z: Uint8Array } | null = null;
  for (const cand of screened.slice(0, 2)) {
    for (const opts of FINAL_OPTS) {
      const z = deflateSync(cand.filtered, opts);
      const bytes = z.length + extraChunkBytes(cand.form);
      if (!winner || bytes < winner.bytes) winner = { form: cand.form, bytes, z };
    }
  }
  return writePng(width, height, winner!.form, winner!.z);
}

// ---------------------------------------------------------------- Driver
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  // Skip stray files: a set holds one directory per instance.
  if (!statSync(join(INPUT_DIR, id)).isDirectory()) continue;
  const { rgba, width, height } = decodePng(
    new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))),
  );
  const png = encodeImage(rgba, width, height);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}
