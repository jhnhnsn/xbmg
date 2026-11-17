import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { downloadOne, runPool, safeName, targetPath } from '../src/download.js';
import { applyFilters, parseDate, parseKinds, summarizeGames } from '../src/filters.js';
import { fetchCaptures, normalize } from '../src/mediahub.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const raw = (overrides = {}) => ({
  contentId: 'abcdef12-0000-0000-0000-000000000000',
  titleName: 'Halo Infinite',
  titleId: 123,
  captureDate: '2026-11-10T20:30:00Z',
  resolutionWidth: 3840,
  resolutionHeight: 2160,
  contentLocators: [
    { locatorType: 'Download', uri: 'https://blob.example/shot.png?sig=x', fileSize: 5 },
    { locatorType: 'Download_HDR', uri: 'https://blob.example/shot.jxr?sig=x', fileSize: 9 },
    { locatorType: 'Thumbnail_Small', uri: 'https://blob.example/small.jpg' },
  ],
  ...overrides,
});

const item = (overrides = {}) => ({ ...normalize('screenshot', raw()), ...overrides });

describe('normalize', () => {
  it('maps locators and metadata', () => {
    const n = normalize('screenshot', raw());
    assert.equal(n.id, 'abcdef12-0000-0000-0000-000000000000');
    assert.equal(n.game, 'Halo Infinite');
    assert.equal(n.url, 'https://blob.example/shot.png?sig=x');
    assert.equal(n.size, 5);
    assert.equal(n.hdrUrl, 'https://blob.example/shot.jxr?sig=x');
    assert.equal(n.thumbUrl, 'https://blob.example/small.jpg');
  });

  it('falls back to uploadDate and a default game name', () => {
    const n = normalize('clip', raw({ captureDate: undefined, uploadDate: '2026-01-01T00:00:00Z', titleName: '' }));
    assert.equal(n.date, '2026-01-01T00:00:00Z');
    assert.equal(n.game, 'Unknown game');
  });
});

describe('filters', () => {
  const items = [
    item({ id: 'aaa1', game: 'Halo Infinite', date: '2026-11-10T10:00:00Z' }),
    item({ id: 'bbb2', game: 'Forza Horizon 5', date: '2026-11-12T10:00:00Z', kind: 'clip' }),
    item({ id: 'ccc3', game: 'Halo Infinite', date: '2026-10-01T10:00:00Z' }),
  ];

  it('sorts newest first', () => {
    assert.deepEqual(applyFilters(items).map((i) => i.id), ['bbb2', 'aaa1', 'ccc3']);
  });

  it('filters by game, case-insensitive', () => {
    assert.deepEqual(applyFilters(items, { game: 'halo' }).map((i) => i.id), ['aaa1', 'ccc3']);
  });

  it('filters by date range and id prefix', () => {
    const since = Date.parse('2026-11-01T00:00:00Z');
    assert.deepEqual(applyFilters(items, { since }).map((i) => i.id), ['bbb2', 'aaa1']);
    assert.deepEqual(applyFilters(items, { ids: ['CCC'] }).map((i) => i.id), ['ccc3']);
  });

  it('applies the limit after sorting', () => {
    assert.deepEqual(applyFilters(items, { limit: 1 }).map((i) => i.id), ['bbb2']);
  });

  it('parses dates', () => {
    const now = Date.parse('2026-11-17T00:00:00Z');
    assert.equal(parseDate('7d', { now }), now - 7 * 86400000);
    const start = parseDate('2026-11-01');
    assert.equal(parseDate('2026-11-01', { endOfDay: true }) - start, 86400000);
    assert.throws(() => parseDate('nope'));
  });

  it('parses kinds', () => {
    assert.deepEqual(parseKinds('all'), ['screenshot', 'clip']);
    assert.deepEqual(parseKinds('Shots'), ['screenshot']);
    assert.deepEqual(parseKinds('clips'), ['clip']);
    assert.throws(() => parseKinds('music'));
  });

  it('summarizes games', () => {
    const s = summarizeGames(items);
    assert.equal(s[0].game, 'Forza Horizon 5');
    assert.deepEqual(s[1], { game: 'Halo Infinite', screenshots: 2, clips: 0, latest: '2026-11-10T10:00:00Z' });
  });
});

describe('paths', () => {
  it('cleans unsafe folder names', () => {
    assert.equal(safeName('Tom Clancy\'s: The Division 2?'), "Tom Clancy's_ The Division 2_");
    assert.equal(safeName('...'), 'Unknown game');
    assert.equal(safeName('a/b\\c'), 'a_b_c');
  });

  it('builds a target path from the URL extension', () => {
    const p = targetPath('/out', item({ date: '2026-11-10T20:30:05' }));
    assert.equal(p, '/out/Halo Infinite/2026-11-10_20-30-05_abcdef12.png');
    assert.match(targetPath('/out', item(), { hdr: true }), /\.jxr$/);
    assert.match(targetPath('/out', item({ kind: 'clip', url: 'https://x/blob' })), /\.mp4$/);
  });
});

describe('fetchCaptures', () => {
  const auth = { uhs: 'u', token: 't', xuid: '42' };

  it('pages until a short page and sends the right request', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, headers: init.headers });
      const count = body.skip === 0 ? 100 : 3;
      const values = Array.from({ length: count }, (_, i) => raw({ contentId: `id-${body.skip + i}` }));
      return Response.json({ values });
    };
    const items = await fetchCaptures('clip', { getAuth: async () => auth });
    assert.equal(items.length, 103);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://mediahub.xboxlive.com/gameclips/search');
    assert.equal(calls[0].body.query, 'OwnerXuid eq 42');
    assert.equal(calls[1].body.skip, 100);
    assert.equal(calls[0].headers.authorization, 'XBL3.0 x=u;t');
  });

  it('gets a new token once after a 401', async () => {
    let n = 0;
    const forced = [];
    globalThis.fetch = async () => (n++ === 0 ? new Response('', { status: 401 }) : Response.json({ values: [] }));
    await fetchCaptures('screenshot', {
      getAuth: async (opts) => {
        forced.push(Boolean(opts?.force));
        return auth;
      },
    });
    assert.deepEqual(forced, [false, true]);
  });

  it('throws on other errors', async () => {
    globalThis.fetch = async () => new Response('boom', { status: 500 });
    await assert.rejects(fetchCaptures('screenshot', { getAuth: async () => auth }), /HTTP 500 boom/);
  });
});

describe('downloadOne', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xbmg-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads, sets the file time, then skips on the next run', async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return new Response('hello');
    };
    const it = item({ size: 5, date: '2026-11-10T20:30:00Z' });
    const dest = join(dir, 'Game', 'file.png');

    assert.equal((await downloadOne(it, dest)).status, 'downloaded');
    assert.equal(await readFile(dest, 'utf8'), 'hello');
    assert.equal((await stat(dest)).mtime.toISOString(), '2026-11-10T20:30:00.000Z');

    assert.equal((await downloadOne(it, dest)).status, 'skipped');
    assert.equal(fetches, 1);
  });

  it('downloads again when the size is wrong', async () => {
    globalThis.fetch = async () => new Response('hello');
    const dest = join(dir, 'file.png');
    await writeFile(dest, 'he');
    assert.equal((await downloadOne(item({ size: 5 }), dest)).status, 'downloaded');
    assert.equal(await readFile(dest, 'utf8'), 'hello');
  });

  it('fails on an HTTP error and leaves no partial file', async () => {
    globalThis.fetch = async () => new Response('no', { status: 403 });
    const dest = join(dir, 'file.png');
    await assert.rejects(downloadOne(item(), dest), /HTTP 403/);
    await assert.rejects(stat(dest));
  });
});

describe('runPool', () => {
  it('limits concurrency and visits every item', async () => {
    let active = 0;
    let peak = 0;
    const seen = [];
    await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      active--;
    });
    assert.equal(peak, 2);
    assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6]);
  });
});
