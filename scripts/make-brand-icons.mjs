// Favicon and Apple touch icon from public/icon.svg.
// Opaque cream (#fff8ef) field, blue triangle mark (#0a5cff), ink eyes and limbs.
// Coral (#ff7a59) is the site theme color; it is not part of the mark.
// Apple touch icons must be fully opaque (color type RGB, no alpha). iOS rounds the square itself.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CREAM = [0xff, 0xf8, 0xef];
const BLUE = [0x0a, 0x5c, 0xff];
const INK = [0x11, 0x11, 0x11];
const LIMB = [0x1c, 0x1b, 0x20];
const A = [32, 11.1], B = [51, 44], C = [13, 44], R = 3.2;

const inc = (() => {
  const [a, b, c] = [A, B, C].map((p, i, P) => Math.hypot(P[(i + 1) % 3][0] - P[(i + 2) % 3][0], P[(i + 1) % 3][1] - P[(i + 2) % 3][1]));
  const s = a + b + c;
  return [(a * A[0] + b * B[0] + c * C[0]) / s, (a * A[1] + b * B[1] + c * C[1]) / s];
})();
const inr = (() => {
  const area = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2;
  const per = Math.hypot(B[0] - A[0], B[1] - A[1]) + Math.hypot(C[0] - B[0], C[1] - B[1]) + Math.hypot(A[0] - C[0], A[1] - C[1]);
  return (2 * area) / per;
})();
const k = (inr - R) / inr;
const T = [A, B, C].map(([x, y]) => [inc[0] + (x - inc[0]) * k, inc[1] + (y - inc[1]) * k]);
const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const inTri = (p, [a, b, c]) => {
  const s = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (w[0] - u[0]) * (v[1] - u[1]);
  const d1 = s(a, b, p), d2 = s(b, c, p), d3 = s(c, a, p);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
};
const inBody = (x, y) => inTri([x, y], T) || Math.min(segDist([x, y], T[0], T[1]), segDist([x, y], T[1], T[2]), segDist([x, y], T[2], T[0])) <= R;
const inEye = (x, y) => [28.9, 35.1].some((cx) => ((x - cx) / 1.4) ** 2 + ((y - 26) / 2.3) ** 2 <= 1);
const quad = (p0, c, p1, n = 12) => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n, u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
});
const LIMBS = [quad([21, 32], [16.5, 34.5], [13, 38.5]), quad([42.5, 30.5], [49.5, 28.5], [50.5, 19.5]), [[27.5, 43], [27.5, 51], [24, 51]], [[36.5, 43], [36.5, 51], [40, 51]]];
const HANDS = [[13, 38.5], [50.5, 19.5]];
const inLimb = (x, y) => HANDS.some(([hx, hy]) => (x - hx) ** 2 + (y - hy) ** 2 <= 1.1 ** 2)
  || LIMBS.some((pl) => pl.slice(1).some((q, i) => segDist([x, y], pl[i], q) <= 0.7));

function sample(x, y) {
  if (inEye(x, y)) return INK;
  if (inBody(x, y)) return BLUE;
  if (inLimb(x, y)) return LIMB;
  return CREAM;
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 8-bit RGB (color type 2): every pixel is opaque. Edges blend onto cream.
export function renderPng(size) {
  const ss = 4, row = size * 3 + 1, px = Buffer.alloc(size * row);
  for (let j = 0; j < size; j++) {
    px[j * row] = 0;
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0;
      for (let sj = 0; sj < ss; sj++) for (let si = 0; si < ss; si++) {
        const x = ((i + (si + 0.5) / ss) / size) * 64;
        const y = ((j + (sj + 0.5) / ss) / size) * 64;
        const c = sample(x, y);
        r += c[0]; g += c[1]; b += c[2];
      }
      const n = ss * ss, o = j * row + 1 + i * 3;
      px[o] = Math.round(r / n); px[o + 1] = Math.round(g / n); px[o + 2] = Math.round(b / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB, no alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function renderIco(sizes) {
  const images = sizes.map((size) => ({ size, png: renderPng(size) }));
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const parts = [header, entries];
  for (let i = 0; i < count; i++) {
    const img = images[i], e = i * 16;
    entries[e] = img.size >= 256 ? 0 : img.size;
    entries[e + 1] = img.size >= 256 ? 0 : img.size;
    entries.writeUInt16LE(1, e + 4);
    entries.writeUInt16LE(32, e + 6);
    entries.writeUInt32LE(img.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
    parts.push(img.png);
  }
  return Buffer.concat(parts);
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const ico = renderIco([16, 32, 48]);
  const touch = renderPng(180);
  if (touch[25] !== 2) throw new Error('apple touch icon must be opaque RGB');
  writeFileSync(join(PUBLIC, 'favicon.ico'), ico);
  writeFileSync(join(PUBLIC, 'apple-touch-icon.png'), touch);
  console.log(`wrote favicon.ico (${ico.length} bytes, 16/32/48) and apple-touch-icon.png (${touch.length} bytes, 180)`);
}
