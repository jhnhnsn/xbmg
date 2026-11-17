import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
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

// Every browser a test makes is closed afterwards, also when an assertion fails, so no timer keeps the run alive.
const open = [];
afterEach(() => {
  for (const b of open.splice(0)) b.quit(true);
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
  open.push(b);
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

  const ID = '1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f';

  function fakeAuth() {
    const calls = [];
    let finish;
    const auth = {
      login: (clientId, { method, onUrl, onCode, onVerify }) => {
        calls.push([clientId, method]);
        if (method === 'code') onCode({ userCode: 'ABCD-EFGH', verificationUri: 'https://www.microsoft.com/link', expiresIn: 900 });
        else onUrl('https://login.example/authorize?x=1');
        return new Promise((r) => {
          finish = () => {
            onVerify();
            r({ gamertag: 'Tester' });
          };
        });
      },
      signOut: async () => ID,
    };
    return { auth, calls, finish: () => finish() };
  }

  it('asks for a client ID, opens the browser, then loads the captures', async () => {
    const opened = [];
    const fake = fakeAuth();
    const { b, text } = makeBrowser({ login: { clientId: '', auto: true }, openUrl: async (u) => opened.push(u), auth: fake.auth });
    await b.start();
    assert.equal(b.loginState.step, 'clientId');
    assert.ok(text().some((l) => l.includes('Client ID')));

    b.input('nope!\r');
    assert.equal(fake.calls.length, 0);
    assert.ok(text().some((l) => l.includes('That is not a client ID')));

    b.input(`\x15 ${ID.toUpperCase()}\r`);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(fake.calls, [[ID, 'browser']]);
    assert.equal(b.loginState.step, 'browser');
    assert.deepEqual(opened, ['https://login.example/authorize?x=1']);
    assert.ok(text().some((l) => l.includes('Waiting for you to sign in in your web browser')));

    fake.finish();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(b.screen, 'browse');
    assert.equal(b.gamertag, 'Tester');
    assert.equal(b.items.length, 40);

    assert.match(text()[0], /Signed in as Tester/);
    b.input('L');
    assert.ok(text().some((l) => l.includes('Sign in as a different user')));
    b.input('o');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(b.screen, 'login');
    assert.equal(b.loginState.step, 'ready');
    assert.equal(b.loginState.clientId, ID);
    assert.match(text()[0], /Not signed in/);
    assert.equal(fake.calls.length, 1, 'sign-out does not open the browser by itself');
    assert.equal(b.items.length, 0);
    b.quit(true);
  });

  it('waits for Enter before it opens the browser', async () => {
    const fake = fakeAuth();
    const { b, text } = makeBrowser({ login: {}, defaultClientId: ID, auth: fake.auth });
    await b.start();
    assert.equal(fake.calls.length, 0);
    assert.ok(text().some((l) => l.includes('You are not signed in')));
    b.input('\r');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(fake.calls, [[ID, 'browser']]);
    b.quit(true);
  });

  it('signs in as a different user from the account box', async () => {
    const fake = fakeAuth();
    const { b } = makeBrowser({ auth: fake.auth, defaultClientId: ID });
    await b.start();
    b.input('Ls');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(b.screen, 'login');
    assert.deepEqual(fake.calls, [[ID, 'browser']]);
    b.quit(true);
  });

  it('opens the browser at once when a default client ID exists', async () => {
    const opened = [];
    const fake = fakeAuth();
    const { b, text } = makeBrowser({ login: { auto: true }, defaultClientId: ID, openUrl: async (u) => opened.push(u), auth: fake.auth });
    await b.start();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(fake.calls, [[ID, 'browser']]);
    assert.equal(opened.length, 1);
    assert.ok(!text().some((l) => l.includes('Client ID')));
    b.quit(true);
  });

  it('switches to a code sign-in with d', async () => {
    const copied = [];
    const fake = fakeAuth();
    const { b, text } = makeBrowser({ login: { auto: true }, defaultClientId: ID, copy: async (t) => copied.push(t), auth: fake.auth });
    await b.start();
    b.input('d');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(fake.calls.at(-1), [ID, 'code']);
    assert.ok(text().some((l) => l.includes('ABCD-EFGH')));
    assert.deepEqual(copied, ['ABCD-EFGH']);
    b.input('\x1b');
    assert.equal(b.loginState.step, 'ready');
    b.quit(true);
  });

  it('uses a code sign-in by default over SSH', async () => {
    const fake = fakeAuth();
    const { b } = makeBrowser({ login: { auto: true }, defaultClientId: ID, preferCode: true, auth: fake.auth });
    await b.start();
    assert.deepEqual(fake.calls, [[ID, 'code']]);
    b.quit(true);
  });

  it('shows the sign-in error with advice and lets you try again', async () => {
    const { b, text } = makeBrowser({
      login: { clientId: '1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f', auto: true },
      auth: {
        login: async () => {
          throw new Error('Could not start sign-in: AADSTS700016: Application not found');
        },
      },
    });
    await b.start();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(b.loginState.step, 'ready');
    assert.ok(text().some((l) => l.includes('AADSTS700016')));
    assert.ok(text().some((l) => l.includes('Check the client ID')));
    b.quit(true);
  });

  it('goes back to the sign-in screen when the saved sign-in fails', async () => {
    const { b, text } = makeBrowser({
      auth: { login: async () => ({}) },
      loadData: async () => {
        throw Object.assign(new Error('Your sign-in expired. Run "xbmg login" again. (invalid_grant)'), {
          auth: true,
          clientId: '1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f',
        });
      },
    });
    await b.start();
    assert.equal(b.screen, 'login');
    assert.equal(b.loginState.clientId, '1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f');
    assert.ok(text().some((l) => l.includes('Your sign-in expired. (invalid_grant)')));
    assert.ok(!text().some((l) => l.includes('xbmg login')));
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

describe('device code sign-in', () => {
  const realFetch = globalThis.fetch;
  const reply = (status, body) => new Response(JSON.stringify(body), { status });

  it('reports the code and URL, then returns the tokens', async (t) => {
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    const { deviceCodeLogin } = await import('../src/auth.js');
    let polls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/devicecode')) {
        return reply(200, { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://www.microsoft.com/link', message: 'Go there', interval: 0.01, expires_in: 60 });
      }
      polls++;
      return polls < 2 ? reply(400, { error: 'authorization_pending' }) : reply(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    };
    const seen = [];
    const ms = await deviceCodeLogin('id', (message, info) => seen.push([message, info]));
    assert.deepEqual(seen, [['Go there', { userCode: 'ABCD-EFGH', verificationUri: 'https://www.microsoft.com/link', expiresIn: 60 }]]);
    assert.equal(ms.refreshToken, 'rt');
    assert.equal(polls, 2);
  });

  it('stops when the signal aborts', async (t) => {
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    const { deviceCodeLogin } = await import('../src/auth.js');
    globalThis.fetch = async (url) =>
      String(url).endsWith('/devicecode')
        ? reply(200, { device_code: 'dc', user_code: 'X', verification_uri: 'u', interval: 0.05, expires_in: 60 })
        : reply(400, { error: 'authorization_pending' });
    const ctrl = new AbortController();
    const job = deviceCodeLogin('id', () => ctrl.abort(), { signal: ctrl.signal });
    await assert.rejects(job, { name: 'AbortError' });
  });

  it('gives advice for known errors', async () => {
    const { authHint } = await import('../src/auth.js');
    assert.match(authHint('AADSTS7000218: client_assertion'), /Allow public client flows/);
    assert.match(authHint('AADSTS700016: not found'), /Personal Microsoft accounts/);
    assert.equal(authHint('something else'), null);
  });
});

describe('browser sign-in', () => {
  const realFetch = globalThis.fetch;
  const visit = async (url) => {
    const { get } = await import('node:http');
    return new Promise((done, fail) => {
      get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => done({ status: res.statusCode, body }));
      }).on('error', fail);
    });
  };

  it('opens the authorize URL with PKCE, takes the redirect, and redeems the code', async (t) => {
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    const { browserLogin } = await import('../src/auth.js');
    let tokenRequest;
    globalThis.fetch = async (url, init) => {
      tokenRequest = Object.fromEntries(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
    };
    let page;
    const ms = await browserLogin('my-id', {
      onUrl: async (url) => {
        const u = new URL(url);
        assert.equal(u.pathname, '/consumers/oauth2/v2.0/authorize');
        assert.equal(u.searchParams.get('client_id'), 'my-id');
        assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
        assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/localhost:\d+$/);
        const back = new URL(u.searchParams.get('redirect_uri').replace('localhost', '127.0.0.1'));
        assert.equal((await visit(`${back}?state=wrong&code=evil`)).body.includes('out of date'), true);
        back.search = new URLSearchParams({ state: u.searchParams.get('state'), code: 'the-code' });
        visit(back.href).then((r) => {
          page = r;
        });
      },
    });
    assert.equal(ms.refreshToken, 'rt');
    assert.equal(tokenRequest.grant_type, 'authorization_code');
    assert.equal(tokenRequest.code, 'the-code');
    assert.ok(tokenRequest.code_verifier.length >= 43);
    await new Promise((r) => setTimeout(r, 20));
    assert.match(page.body, /You are signed in/);
  });

  it('reports an error that Microsoft sends back', async () => {
    const { browserLogin } = await import('../src/auth.js');
    const job = browserLogin('my-id', {
      onUrl: async (url) => {
        const u = new URL(url);
        const back = new URL(u.searchParams.get('redirect_uri').replace('localhost', '127.0.0.1'));
        back.search = new URLSearchParams({ state: u.searchParams.get('state'), error: 'access_denied', error_description: 'The user declined.' });
        visit(back.href).catch(() => {});
      },
    });
    await assert.rejects(job, /Sign-in failed: The user declined/);
  });

  it('stops when the signal aborts and closes the server', async () => {
    const { browserLogin } = await import('../src/auth.js');
    const ctrl = new AbortController();
    let redirect;
    const job = browserLogin('my-id', {
      signal: ctrl.signal,
      onUrl: (url) => {
        redirect = new URL(url).searchParams.get('redirect_uri').replace('localhost', '127.0.0.1');
        ctrl.abort();
      },
    });
    await assert.rejects(job, { name: 'AbortError' });
    await assert.rejects(visit(`${redirect}?code=x&state=y`));
  });
});

describe('viewer and links', () => {
  const now = new Date('2026-11-17T12:00:00');

  it('reads when an Xbox link expires', async () => {
    const { linkExpiry } = await import('../src/tui/app.js');
    const later = new Date('2026-11-17T18:30:00');
    assert.equal(linkExpiry(`https://x.example/a.mp4?sv=1&se=${encodeURIComponent(later.toISOString())}&sig=z`, now), '18:30');
    assert.equal(linkExpiry('https://x.example/a.mp4?sig=z', now), null);
    assert.equal(linkExpiry('not a url', now), null);
  });

  it('copies the links of the selection with y', async () => {
    const copied = [];
    const items = demoItems(5).map((i, n) => ({ ...i, url: `https://x.example/${n}.png?se=2099-01-01T00:00:00Z` }));
    const { b, text } = makeBrowser({ items, copy: async (t) => copied.push(t) });
    await b.start();
    b.input('  y');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(copied.length, 1);
    assert.equal(copied[0].split('\n').length, 2);
    assert.match(text().at(-1), /Copied 2 links\. Xbox links stop working at/);
  });

  it('shows a screenshot full size and steps with the arrow keys', async () => {
    const items = demoItems(6).filter((i) => i.kind === 'screenshot');
    const fetched = [];
    const { b, out, text } = makeBrowser({
      items,
      fetchFull: async (item) => {
        fetched.push(item.id);
        return makePng(64, 36, () => [200, 100, 50]);
      },
    });
    await b.start();
    b.input('\r');
    assert.equal(b.mode, 'view');
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(text().some((l) => l.includes('Screenshot')));
    assert.match(b.plan.id, /^full:/);
    assert.match(out.join(''), /\x1b_Ga=p,i=\d+,p=1,c=\d+,r=\d+/);
    b.input('\x1b[C');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fetched.length, 2);
    assert.equal(b.itemIndex, 1);
    b.input('\x1b');
    assert.equal(b.mode, 'normal');
  });

  it('plays a clip with ffmpeg frames and pauses with Space', async () => {
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    const spawned = [];
    const spawnFn = (cmd, args) => {
      const p = new EventEmitter();
      p.stdout = new PassThrough();
      p.stderr = new PassThrough();
      p.kill = () => p.emit('close', null);
      spawned.push({ cmd, args, p });
      return p;
    };
    const { VideoPlayer } = await import('../src/tui/video.js');
    const writes = [];
    const player = new VideoPlayer({
      input: (from) => ['-ss', String(from), '-i', 'clip.mp4'],
      audio: (from) => ['-ss', String(from), 'clip.mp4'],
      protocol: 'kitty',
      write: (s) => writes.push(s),
      box: { row: 2, col: 2, cols: 40, rows: 12 },
      size: { w: 4, h: 2 },
      duration: 10,
      spawnFn,
    });
    player.play();
    assert.deepEqual(
      spawned.map((s) => s.cmd),
      ['ffmpeg', 'ffplay'],
    );
    assert.ok(spawned[0].args.includes('-re'));
    assert.ok(spawned[0].args.includes('rgb24'));
    spawned[0].p.stdout.write(Buffer.alloc(4 * 2 * 3 * 2));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(writes.length, 2);
    assert.match(writes[0], /a=T,f=24,s=4,v=2,o=z,i=\d+,p=1,c=40,r=12/);
    assert.ok(Math.abs(player.pos - 2 / 15) < 1e-9);
    player.toggle();
    assert.equal(player.playing, false);
    player.seek(5);
    const still = spawned.at(-1);
    assert.ok(still.args.includes('-frames:v'));
    assert.equal(still.args[still.args.indexOf('-ss') + 1], String(5 + 2 / 15));
    player.close();
  });

  it('splits a JPEG stream into images', async () => {
    const { jpegSplitter } = await import('../src/tui/video.js');
    const got = [];
    const feed = jpegSplitter((img) => got.push([...img]));
    feed(Buffer.from([0x00, 0xff, 0xd8, 1, 2]));
    feed(Buffer.from([0xff, 0xd9, 0xff, 0xd8, 3, 0xff, 0xd9]));
    assert.deepEqual(got, [
      [0xff, 0xd8, 1, 2, 0xff, 0xd9],
      [0xff, 0xd8, 3, 0xff, 0xd9],
    ]);
  });
});
