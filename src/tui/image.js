/** Inline image support: protocol detection, encoding, and a thumbnail cache. */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Picks an image protocol for this terminal: "kitty" (kitty, Ghostty),
 * "iterm" (iTerm2, WezTerm) or null. XBMG_IMAGES=kitty|iterm|none overrides it.
 */
export function detectImageProtocol(env = process.env) {
  const forced = env.XBMG_IMAGES?.toLowerCase();
  if (forced) return ['kitty', 'iterm'].includes(forced) ? forced : null;
  if (env.TMUX || env.STY) return null;
  const program = env.TERM_PROGRAM ?? '';
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') return 'kitty';
  if (program === 'ghostty' || env.TERM === 'xterm-ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'kitty';
  if (program === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2' || program === 'WezTerm') return 'iterm';
  return null;
}

const ESC_ST = '\x1b\\';

/** Sends a PNG to a kitty-protocol terminal and stores it under `id`. Nothing is shown yet. */
export function kittyTransmit(id, png) {
  const b64 = png.toString('base64');
  const parts = [];
  for (let i = 0; i < b64.length; i += 4096) parts.push(b64.slice(i, i + 4096));
  return parts
    .map((chunk, n) => {
      const more = n < parts.length - 1 ? 1 : 0;
      const keys = n === 0 ? `a=t,f=100,t=d,i=${id},q=2,m=${more}` : `q=2,m=${more}`;
      return `\x1b_G${keys};${chunk}${ESC_ST}`;
    })
    .join('');
}

/** Shows a stored image at the cursor, scaled to cols x rows cells, without moving the cursor. */
export function kittyPlace(id, cols, rows) {
  return `\x1b_Ga=p,i=${id},p=1,c=${cols},r=${rows},C=1,q=2${ESC_ST}`;
}

/** Removes every visible placement but keeps the stored images. */
export const kittyClear = `\x1b_Ga=d,d=a,q=2${ESC_ST}`;
/** Removes every placement and frees the stored images. */
export const kittyFree = `\x1b_Ga=d,d=A,q=2${ESC_ST}`;

/** iTerm2 inline image at the cursor, cols x rows cells. Any format macOS can read works. */
export function itermImage(data, cols, rows) {
  return `\x1b]1337;File=inline=1;size=${data.length};width=${cols};height=${rows};preserveAspectRatio=1:${data.toString('base64')}\x07`;
}

/** Largest cols x rows cell box that keeps the image aspect ratio inside the given box. */
export function fitCells(pxW, pxH, cols, rows, cellW = 8, cellH = 16) {
  if (!pxW || !pxH) return { cols, rows };
  const scale = Math.min((cols * cellW) / pxW, (rows * cellH) / pxH);
  return {
    cols: Math.max(1, Math.min(cols, Math.round((pxW * scale) / cellW))),
    rows: Math.max(1, Math.min(rows, Math.round((pxH * scale) / cellH))),
  };
}

export function isPng(buf) {
  return buf?.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a;
}

export function pngSize(buf) {
  return isPng(buf) ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
}

function sniffExt(buf) {
  if (isPng(buf)) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return '.img';
}

function run(cmd, args) {
  return new Promise((done, fail) => execFile(cmd, args, { timeout: 15000 }, (e) => (e ? fail(e) : done())));
}

/**
 * Converts any image to a PNG no larger than maxPx on its long side. Uses the
 * built-in `sips` on macOS, then ImageMagick or ffmpeg when they are installed.
 */
export async function toPng(buf, maxPx = 960) {
  const dir = await mkdtemp(join(tmpdir(), 'xbmg-'));
  const input = join(dir, `in${sniffExt(buf)}`);
  const output = join(dir, 'out.png');
  const tools = [
    ...(process.platform === 'darwin' ? [['sips', ['-s', 'format', 'png', '-Z', String(maxPx), input, '--out', output]]] : []),
    ['magick', [input, '-resize', `${maxPx}x${maxPx}>`, output]],
    ['convert', [input, '-resize', `${maxPx}x${maxPx}>`, output]],
    ['ffmpeg', ['-loglevel', 'error', '-y', '-i', input, '-vf', `scale='min(${maxPx},iw)':-2`, '-frames:v', '1', output]],
  ];
  try {
    await writeFile(input, buf);
    for (const [cmd, args] of tools) {
      try {
        await run(cmd, args);
        const png = await readFile(output);
        if (isPng(png)) return png;
      } catch {
        // Try the next tool.
      }
    }
    throw new Error('No image converter found (install ImageMagick or ffmpeg).');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function thumbCacheDir() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'xbmediagrabber', 'thumbs');
}

async function fetchThumb(item) {
  if (!item.thumbUrl) throw new Error('No preview for this capture.');
  const res = await fetch(item.thumbUrl);
  if (!res.ok) throw new Error(`Preview failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Loads thumbnails once per capture and keeps them in memory and on disk.
 * Each entry is { status: "loading" | "ready" | "error", data, png, width, height, error }.
 */
export class ThumbCache {
  constructor({ fetcher = fetchThumb, convert = toPng, dir = thumbCacheDir(), needPng = true } = {}) {
    this.fetcher = fetcher;
    this.convert = convert;
    this.dir = dir;
    this.needPng = needPng;
    this.entries = new Map();
    this.pending = new Map();
  }

  peek(id) {
    return this.entries.get(id);
  }

  get(item) {
    if (this.pending.has(item.id)) return this.pending.get(item.id);
    const existing = this.entries.get(item.id);
    if (existing && existing.status !== 'loading') return Promise.resolve(existing);
    this.entries.set(item.id, { status: 'loading' });
    const job = this.load(item)
      .catch((e) => ({ status: 'error', error: e.message }))
      .then((entry) => {
        this.entries.set(item.id, entry);
        this.pending.delete(item.id);
        return entry;
      });
    this.pending.set(item.id, job);
    return job;
  }

  diskPath(id) {
    return this.dir && join(this.dir, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.png`);
  }

  async load(item) {
    const file = this.diskPath(item.id);
    if (file) {
      const cached = await readFile(file).catch(() => null);
      if (isPng(cached)) return this.ready(cached, item);
    }
    const raw = await this.fetcher(item);
    let png = isPng(raw) && raw.length < 800_000 ? raw : null;
    if (!png) {
      try {
        png = await this.convert(raw);
      } catch (e) {
        if (this.needPng) throw e;
      }
    }
    if (png && file) {
      await mkdir(this.dir, { recursive: true })
        .then(() => writeFile(file, png))
        .catch(() => {});
    }
    return this.ready(png ?? raw, item, !!png);
  }

  ready(data, item, png = true) {
    const size = (png && pngSize(data)) || { width: item.width, height: item.height };
    return { status: 'ready', data, png, ...size };
  }
}
