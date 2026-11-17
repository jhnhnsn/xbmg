import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Browser, scrollFor } from '../src/tui/app.js';
import { demoItems, makePng } from '../src/tui/demo.js';
import { ThumbCache, detectImageProtocol, fitCells, kittyTransmit, pngSize } from '../src/tui/image.js';
import { parseInput } from '../src/tui/keys.js';
import { Line, fit, plain, strWidth } from '../src/tui/text.js';

const tinyPng = makePng(16, 9, () => [10, 20, 30]);

describe('keys', () => {
  it('parses arrows, control keys, text and escape', () => {
    const names = parseInput('\x1b[A\x1b[B\x1bOC\x1b[6~\x04 é\x1b\r\x7f\t\x1b[Z').map((e) => (e.ctrl ? `^${e.name}` : e.name));
    assert.deepEqual(names, ['up', 'down', 'right', 'pagedown', '^d', ' ', 'é', 'escape', 'enter', 'backspace', 'tab', 'backtab']);
  });

  it('parses SGR mouse and the cell size report', () => {
    assert.deepEqual(parseInput('\x1b[<0;5;3M')[0], { name: 'mouse', x: 4, y: 2, action: 'press' });
    assert.equal(parseInput('\x1b[<65;1;1M')[0].action, 'wheeldown');
    assert.equal(parseInput('\x1b[<64;1;1M')[0].action, 'wheelup');
    assert.deepEqual(parseInput('\x1b[6;20;10t')[0], { name: 'cellsize', h: 20, w: 10 });
  });
});

describe('text', () => {
  it('measures wide characters and cuts to an exact width', () => {
    assert.equal(strWidth('ルミナス'), 8);
    assert.equal(fit('ルミナス・ガーデン', 7), 'ルミナ…');
    assert.equal(fit('ルミナス・ガーデン', 6), 'ルミ… ');
    assert.equal(strWidth(fit('ルミナス・ガーデン', 7)), 7);
    assert.equal(fit('abc', 5, { align: 'right' }), '  abc');
  });

  it('removes control characters from untrusted text', () => {
    assert.equal(fit('a\x1b[2Jb', 6), 'a [2Jb');
  });

  it('builds styled lines of an exact width', () => {
    const line = new Line(10).add('hello', '\x1b[1m').add(' world and more').done();
    assert.equal(plain(line), 'hello wor…');
  });
});

describe('images', () => {
  it('detects the protocol from the environment', () => {
    assert.equal(detectImageProtocol({ TERM_PROGRAM: 'ghostty' }), 'kitty');
    assert.equal(detectImageProtocol({ TERM: 'xterm-kitty' }), 'kitty');
    assert.equal(detectImageProtocol({ TERM_PROGRAM: 'iTerm.app' }), 'iterm');
    assert.equal(detectImageProtocol({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/x' }), null);
    assert.equal(detectImageProtocol({ TERM_PROGRAM: 'Apple_Terminal' }), null);
    assert.equal(detectImageProtocol({ XBMG_IMAGES: 'none', TERM_PROGRAM: 'ghostty' }), null);
  });

  it('sends kitty images in chunks of 4096 base64 characters', () => {
    const seq = kittyTransmit(7, Buffer.alloc(5000));
    const chunks = seq.split('\x1b\\').filter(Boolean);
    assert.equal(chunks.length, 2);
    assert.match(chunks[0], /^\x1b_Ga=t,f=100,t=d,i=7,q=2,m=1;/);
    assert.match(chunks[1], /^\x1b_Gq=2,m=0;/);
    assert.equal(chunks[0].split(';')[1].length, 4096);
  });

  it('fits an image into a cell box and keeps the aspect ratio', () => {
    assert.deepEqual(fitCells(1920, 1080, 60, 30, 8, 16), { cols: 60, rows: 17 });
    assert.deepEqual(fitCells(1080, 1920, 60, 30, 8, 16), { cols: 34, rows: 30 });
  });

  it('makes valid PNGs for the demo', () => {
    assert.deepEqual(pngSize(tinyPng), { width: 16, height: 9 });
  });

  it('converts non-PNG thumbnails once and caches the result', async () => {
    let fetches = 0;
    let converts = 0;
    const cache = new ThumbCache({
      dir: null,
      fetcher: async () => {
        fetches++;
        return Buffer.from([0xff, 0xd8, 0xff, 0x00]);
      },
      convert: async () => {
        converts++;
        return tinyPng;
      },
    });
    const item = { id: 'a' };
    const [one, two] = await Promise.all([cache.get(item), cache.get(item)]);
    assert.equal(one, two);
    assert.equal(one.status, 'ready');
    assert.equal(one.width, 16);
    await cache.get(item);
    assert.deepEqual([fetches, converts], [1, 1]);
  });

  it('records a failed thumbnail as an error entry', async () => {
    const cache = new ThumbCache({
      dir: null,
      fetcher: async () => {
        throw new Error('HTTP 403');
      },
    });
    const entry = await cache.get({ id: 'x' });
    assert.deepEqual(entry, { status: 'error', error: 'HTTP 403' });
  });
});

function makeBrowser({ cols = 120, rows = 30, protocol = 'kitty', items = demoItems(40, Date.parse('2026-11-17T12:00:00Z')), ...rest } = {}) {
  const out = [];
  const downloads = [];
  const b = new Browser({
    write: (s) => out.push(s),
    size: () => ({ cols, rows }),
    protocol,
    checkLocal: false,
    loadData: async () => ({ gamertag: 'Tester', items }),
    thumbs: new ThumbCache({ dir: null, fetcher: async () => tinyPng }),
    download: async (item, dest) => {
      downloads.push(dest);
      return { status: 'downloaded', bytes: 1 };
    },
    openUrl: async () => {},
    outDir: '/tmp/xbmg-test-out',
    ...rest,
  });
  return { b, out, downloads, text: () => b.prev.map(plain) };
}

describe('browser', () => {
  it('scrolls to keep the cursor visible', () => {
    assert.equal(scrollFor(0, 0, 10, 100), 0);
    assert.equal(scrollFor(15, 0, 10, 100), 6);
    assert.equal(scrollFor(3, 6, 10, 100), 3);
    assert.equal(scrollFor(99, 0, 10, 5), 0);
  });

  for (const [cols, rows] of [
    [160, 40],
    [100, 24],
    [80, 24],
    [50, 15],
    [30, 8],
  ]) {
    it(`draws every row at exactly ${cols} columns (${cols}x${rows})`, async () => {
      const { b, text } = makeBrowser({ cols, rows });
      await b.start();
      for (const keys of ['', 'jjj', '?', 'x', 'h', 'tt', '/zz\r']) {
        b.input(keys);
        const lines = text();
        assert.equal(lines.length, rows);
        for (const l of lines) assert.equal(strWidth(l), cols, JSON.stringify(l));
      }
      b.quit(true);
    });
  }

  it('selects with space and downloads only the selection', async () => {
    const { b, downloads, text } = makeBrowser();
    await b.start();
    b.input('  ');
    assert.equal(b.selected.size, 2);
    assert.match(text()[0], /2 selected/);
    await b.downloadSelection();
    assert.equal(downloads.length, 2);
    assert.ok(downloads.every((d) => d.startsWith('/tmp/xbmg-test-out/')));
    assert.equal(b.selected.size, 0);
    assert.equal(b.local.size, 2);
    assert.match(text().at(-1), /Saved 2, 0 already there, 0 failed/);
    b.quit(true);
  });

  it('selects all captures of a game with space in the games pane', async () => {
    const { b } = makeBrowser();
    await b.start();
    b.input('hj ');
    const game = b.games[1];
    assert.equal(b.selected.size, game.count);
    b.input(' ');
    assert.equal(b.selected.size, 0);
    b.quit(true);
  });

  it('filters games by name and by type', async () => {
    const { b } = makeBrowser();
    await b.start();
    b.input('/neon\r');
    assert.ok(b.visible.length > 0);
    assert.ok(b.visible.every((i) => i.game === 'Neon Rally 2'));
    b.input('t');
    assert.ok(b.visible.every((i) => i.kind === 'screenshot'));
    b.input('\x1b');
    assert.equal(b.query, '');
    b.quit(true);
  });

  it('places the thumbnail with the kitty protocol when it loads', async () => {
    const { b, out } = makeBrowser();
    await b.start();
    await new Promise((r) => setTimeout(r, 150));
    const all = out.join('');
    assert.match(all, /\x1b_Ga=t,f=100,t=d,i=1,/);
    assert.match(all, /\x1b_Ga=p,i=1,p=1,c=\d+,r=\d+,C=1,q=2/);
    assert.ok(b.plan);
    b.quit(true);
  });

  it('shows the error and retries with r', async () => {
    let calls = 0;
    const { b, text } = makeBrowser({
      loadData: async () => {
        calls++;
        if (calls === 1) throw new Error('Xbox said no');
        return { gamertag: 'Tester', items: [] };
      },
    });
    await b.start();
    assert.ok(text().some((l) => l.includes('Xbox said no')));
    b.input('r');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 2);
    assert.ok(text().some((l) => l.includes('No captures')));
    b.quit(true);
  });
});
