/** Made-up captures and generated thumbnails, so the browser can be tried without signing in. */

import { setTimeout as sleep } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { ThumbCache } from './image.js';

const GAMES = [
  ['Starfall Odyssey', 210],
  ['Neon Rally 2', 300],
  ['Hollow Keep', 20],
  ['Tidebreaker', 185],
  ['Ashen Frontier', 35],
  ['Pocket Kart Deluxe', 120],
  ['ルミナス・ガーデン', 330],
];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes an RGB image as PNG. pixel(x, y) returns [r, g, b]. */
export function makePng(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Draws a small landscape: sky, sun, two mountain ranges and a dark ground. */
function scene(item, w = 384, h = 216) {
  const r = rng(item.seed);
  const hue = item.hue + (r() - 0.5) * 40;
  const sunX = 0.15 + r() * 0.7;
  const sunY = 0.2 + r() * 0.3;
  const p1 = r() * 10;
  const p2 = r() * 10;
  return makePng(w, h, (x, y) => {
    const u = x / w;
    const v = y / h;
    const far = 0.55 + 0.08 * Math.sin(u * 7 + p1) + 0.04 * Math.sin(u * 19 + p2);
    const near = 0.7 + 0.07 * Math.sin(u * 4 + p2) + 0.03 * Math.sin(u * 23 + p1);
    if (v > 0.86) return hsl(hue + 180, 0.25, 0.08 + (1 - v) * 0.3);
    if (v > near) return hsl(hue + 160, 0.35, 0.14);
    if (v > far) return hsl(hue + 20, 0.3, 0.28 - (v - far) * 0.4);
    const d = Math.hypot((u - sunX) * 1.78, v - sunY);
    if (d < 0.09) return hsl(45, 1, 0.75);
    const glow = Math.max(0, 0.25 - d) * 1.2;
    return hsl(hue + v * 40, 0.65, Math.min(0.85, 0.22 + v * 0.45 + glow));
  });
}

export function demoItems(count = 140, now = Date.now()) {
  const r = rng(42);
  return Array.from({ length: count }, (_, n) => {
    const [game, hue] = GAMES[Math.floor(r() * r() * GAMES.length * 1.6) % GAMES.length];
    const clip = r() < 0.3;
    const big = r() < 0.6;
    const id = Array.from({ length: 4 }, () => Math.floor(r() * 0xffffffff).toString(16).padStart(8, '0')).join('');
    const id36 = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
    return {
      kind: clip ? 'clip' : 'screenshot',
      id: id36,
      game,
      titleId: hue,
      date: new Date(now - Math.floor(r() * 120 * 86400000)).toISOString(),
      width: big ? 3840 : 1920,
      height: big ? 2160 : 1080,
      duration: clip ? 10 + Math.floor(r() * 110) : undefined,
      caption: r() < 0.08 ? 'What a run!' : '',
      url: undefined,
      size: clip ? Math.floor((5 + r() * 120) * 1024 * 1024) : Math.floor((1 + r() * 9) * 1024 * 1024),
      hdrUrl: !clip && big && r() < 0.5 ? 'demo:hdr' : undefined,
      hdrSize: Math.floor((10 + r() * 20) * 1024 * 1024),
      thumbUrl: 'demo:thumb',
      seed: n + 1,
      hue,
    };
  }).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

export function demoDeps() {
  return {
    demo: true,
    checkLocal: false,
    loadData: async () => {
      await sleep(700);
      return { gamertag: 'DemoPlayer', items: demoItems() };
    },
    thumbs: new ThumbCache({ dir: null, fetcher: async (item) => scene(item) }),
    fetchFull: async (item) => scene(item, 1280, 720),
    // A generated test picture stands in for the clip. It needs ffmpeg, like real clips.
    videoSource: (item) => ({
      input: (from) => ['-ss', String(from), '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${item.duration}`],
      audio: null,
    }),
    download: async (item) => {
      await sleep(200 + Math.random() * 600);
      return { status: 'downloaded', bytes: item.size };
    },
    openUrl: async () => {
      throw new Error('demo captures have no real link');
    },
  };
}
