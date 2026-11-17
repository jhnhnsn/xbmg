import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const pad = (n) => String(n).padStart(2, '0');

export function formatStamp(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return 'unknown-date';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Makes a game name safe to use as a folder name on macOS, Windows and Linux. */
export function safeName(name) {
  const clean = String(name ?? '')
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 100);
  return clean || 'Unknown game';
}

/** Picks the source URL and size for an item. */
export function source(item, { hdr = false } = {}) {
  if (hdr && item.hdrUrl) return { url: item.hdrUrl, size: item.hdrSize };
  return { url: item.url, size: item.size };
}

export function targetPath(outDir, item, { hdr = false } = {}) {
  const { url } = source(item, { hdr });
  let ext = '';
  try {
    ext = extname(new URL(url).pathname).toLowerCase();
  } catch {
    // Fall back below.
  }
  if (!ext || ext.length > 6) ext = item.kind === 'clip' ? '.mp4' : '.png';
  const shortId = String(item.id ?? 'noid').slice(0, 8);
  return join(outDir, safeName(item.game), `${formatStamp(item.date)}_${shortId}${ext}`);
}

async function existingSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/**
 * Downloads one item to dest. Returns "skipped" when the file is already
 * there with the expected size, or "downloaded" with the byte count.
 */
export async function downloadOne(item, dest, { hdr = false } = {}) {
  const { url, size } = source(item, { hdr });
  if (!url) throw new Error('No download link for this capture.');

  const have = await existingSize(dest);
  if (have !== null && (size ? have === size : have > 0)) return { status: 'skipped', bytes: have };

  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await rename(tmp, dest);

  const when = new Date(item.date);
  if (!Number.isNaN(when.getTime())) await utimes(dest, when, when).catch(() => {});
  return { status: 'downloaded', bytes: (await existingSize(dest)) ?? 0 };
}

/** Runs fn over items with at most `jobs` in flight. */
export async function runPool(items, jobs, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, worker));
}
