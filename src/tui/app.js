/** Full-screen browser: games, captures and a preview with an inline image. */

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  AuthError,
  CLIENT_ID_RE,
  DEFAULT_CLIENT_ID,
  authHint,
  browserLogin,
  deviceCodeLogin,
  getXboxAuth,
  preferDeviceCode,
} from '../auth.js';
import { downloadOne, runPool, source, targetPath } from '../download.js';
import { applyFilters, parseDate, parseKinds, summarizeGames } from '../filters.js';
import { formatBytes } from '../format.js';
import { fetchAll } from '../mediahub.js';
import { clearSession, loadSession, saveSession } from '../session.js';
import {
  ThumbCache,
  detectImageProtocol,
  fitCells,
  isPng,
  itermImage,
  kittyClear,
  kittyFree,
  kittyPlace,
  kittyTransmit,
  pngSize,
  toPng,
} from './image.js';
import { parseInput } from './keys.js';
import { Line, R, fit, strWidth, style } from './text.js';
import { VideoPlayer } from './video.js';

const COLOR = { accent: 75, pink: 212, green: 114, yellow: 221, red: 203, dim: 245, border: 239, focusBg: 24, rowBg: 236, headerBg: 235 };

const S = {
  bold: style({ bold: true }),
  italic: style({ italic: true }),
  dim: style({ fg: COLOR.dim }),
  accent: style({ fg: COLOR.accent }),
  accentBold: style({ fg: COLOR.accent, bold: true }),
  pink: style({ fg: COLOR.pink }),
  green: style({ fg: COLOR.green }),
  yellow: style({ fg: COLOR.yellow }),
  red: style({ fg: COLOR.red }),
  border: style({ fg: COLOR.border }),
  focusRow: style({ bg: COLOR.focusBg, fg: 231 }),
  row: style({ bg: COLOR.rowBg }),
  header: style({ bg: COLOR.headerBg }),
  brand: style({ bg: COLOR.accent, fg: 16, bold: true }),
  tabOn: style({ bg: COLOR.accent, fg: 16, bold: true }),
  tabOff: style({ fg: COLOR.dim }),
  field: style({ bg: COLOR.rowBg, fg: 231 }),
  fieldCursor: style({ bg: COLOR.rowBg, fg: COLOR.accent }),
  link: style({ fg: COLOR.accent, underline: true }),
  code: style({ bg: COLOR.accent, fg: 16, bold: true }),
};

const KIND_TABS = [
  ['all', 'All'],
  ['screenshot', 'Shots'],
  ['clip', 'Clips'],
];

const HINTS = [
  ['↑↓', 'move'],
  ['Enter', 'view'],
  ['Space', 'select'],
  ['d', 'download'],
  ['y', 'copy link'],
  ['o', 'open'],
  ['t', 'type'],
  ['/', 'filter'],
  ['L', 'account'],
  ['?', 'help'],
  ['q', 'quit'],
];

const VIEW_HINTS = {
  screenshot: [
    ['← →', 'previous/next'],
    ['y', 'copy link'],
    ['d', 'download'],
    ['o', 'open in browser'],
    ['Esc', 'close'],
  ],
  clip: [
    ['Space', 'play/pause'],
    ['← →', '5 s'],
    ['[ ]', 'previous/next'],
    ['m', 'sound'],
    ['y', 'copy link'],
    ['d', 'download'],
    ['Esc', 'close'],
  ],
};

/** Widest video frame in pixels that the viewer asks ffmpeg for. Wider frames look sharper but need more terminal bandwidth. */
const VIDEO_WIDTH = Number(process.env.XBMG_VIDEO_WIDTH) || 640;

const HELP = [
  ['↑ ↓  j k', 'Move in the list'],
  ['PgUp PgDn  ^u ^d', 'Move one page'],
  ['g G  Home End', 'Go to the first or last item'],
  ['← →  h l  Tab', 'Change pane'],
  ['Enter  v', 'Open the game, or view the capture here'],
  ['Space', 'Select a capture (on a game: all its captures)'],
  ['a', 'Select all captures in the list, or none'],
  ['Esc', 'Clear the selection, then the filter'],
  ['d', 'Download the selection (or the current capture)'],
  ['o', 'Open the current capture in your browser'],
  ['y', 'Copy the download link (of the selection, or the capture)'],
  ['t', 'Show all, screenshots or clips'],
  ['/', 'Filter games by name'],
  ['p', 'Show or hide image previews'],
  ['r', 'Fetch the captures again'],
  ['L', 'Account: sign in as a different user, or sign out'],
  ['q  Ctrl-C', 'Quit'],
];

const PORTAL_URL = 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade';

const LOGIN_HINTS = {
  clientId: [
    ['Enter', 'continue'],
    ['Ctrl-O', 'open portal'],
    ['Ctrl-U', 'clear'],
    ['Esc', 'back'],
  ],
  ready: [
    ['Enter', 'sign in'],
    ['d', 'use a code'],
    ['i', 'client ID'],
    ['Esc', 'quit'],
  ],
  browser: [
    ['Enter', 'open again'],
    ['c', 'copy link'],
    ['d', 'use a code'],
    ['Esc', 'cancel'],
  ],
  code: [
    ['Enter', 'open browser'],
    ['c', 'copy code'],
    ['Esc', 'cancel'],
  ],
  other: [['Esc', 'cancel']],
};

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const pad2 = (n) => String(n).padStart(2, '0');
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function formatDate(iso, short = false) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown date';
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const day = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return short ? `${day} ${time}` : `${d.getFullYear()}-${day} ${time}`;
}

function formatDuration(s) {
  if (!s) return '';
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${pad2(t % 60)}`;
}

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && strWidth(line) + 1 + strWidth(word) > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

const mmss = (sec) => {
  const t = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(t / 60)}:${pad2(t % 60)}`;
};

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** When an Xbox (Azure Storage) link stops working, from its "se" parameter. Null when unknown. */
export function linkExpiry(url, now = new Date()) {
  try {
    const t = Date.parse(new URL(url).searchParams.get('se') ?? '');
    if (Number.isNaN(t)) return null;
    const d = new Date(t);
    const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return d.toDateString() === now.toDateString() ? time : formatDate(d.toISOString());
  } catch {
    return null;
  }
}

/** Keeps `index` inside a window of `height` rows that starts at `scroll`. */
export function scrollFor(index, scroll, height, length) {
  let s = scroll;
  if (index < s) s = index;
  if (index >= s + height) s = index - height + 1;
  return clamp(s, 0, Math.max(0, length - height));
}

/** Draws a rounded box around content lines that are already exactly w-2 cells wide. */
function box(content, w, h, { title = '', right = '', focused = false } = {}) {
  const bc = focused ? S.accent : S.border;
  const ts = focused ? S.accentBold : S.bold;
  let t = ` ${title} `;
  let r = right ? ` ${right} ` : '';
  if (4 + strWidth(t) + strWidth(r) > w) r = '';
  if (4 + strWidth(t) > w) t = fit(t, Math.max(0, w - 4));
  const dashes = Math.max(0, w - 4 - strWidth(t) - strWidth(r));
  const lines = [`${bc}╭─${R}${ts}${t}${R}${bc}${'─'.repeat(dashes)}${R}${S.dim}${r}${R}${bc}─╮${R}`];
  const blank = ' '.repeat(Math.max(0, w - 2));
  for (let i = 0; i < h - 2; i++) lines.push(`${bc}│${R}${content[i] ?? blank}${bc}│${R}`);
  lines.push(`${bc}╰${'─'.repeat(Math.max(0, w - 2))}╯${R}`);
  return lines;
}

function centered(text, w, st = '') {
  const tw = Math.min(strWidth(text), w);
  const left = Math.floor((w - tw) / 2);
  return new Line(w).add('', '', left).add(text, st, w - left).done();
}

/** Draws content in a box of width w, centred in a cols x h area. */
function centerBox(content, w, cols, h, title) {
  const boxH = Math.min(h, content.length + 2);
  const drawn = box(content, w, boxH, { title, focused: true });
  const left = Math.floor((cols - w) / 2);
  const top = Math.max(0, Math.floor((h - boxH) / 2));
  const lines = Array.from({ length: h }, () => ' '.repeat(cols));
  drawn.forEach((d, i) => {
    lines[top + i] = `${' '.repeat(left)}${d}${' '.repeat(cols - left - w)}`;
  });
  return lines;
}

function pipeTo(cmd, args, text) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`${cmd} exited with ${code}`))));
    child.stdin.end(text);
  });
}

/** Copies text with the system clipboard tool. Rejects when none works. */
async function copyNative(text) {
  const tools =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
  for (const [cmd, args] of tools) {
    try {
      return await pipeTo(cmd, args, text);
    } catch {
      // Try the next tool.
    }
  }
  throw new Error('No clipboard tool found.');
}

export class Browser {
  constructor({
    write,
    size,
    loadData,
    thumbs,
    download,
    openUrl,
    outDir = resolve('xbox-captures'),
    hdr = false,
    jobs = 4,
    protocol = null,
    demo = false,
    checkLocal = true,
    initial = {},
    auth = null,
    copy = async () => {},
    login = null,
    defaultClientId = '',
    preferCode = false,
    fetchFull = null,
    convert = toPng,
    videoSource = null,
    canWrite = () => true,
  }) {
    Object.assign(this, { write, size, loadData, thumbs, download, openUrl, outDir, hdr, jobs, protocol, demo, auth, copy });
    this.shouldCheckLocal = checkLocal;
    this.initialLogin = login;
    this.defaultClientId = defaultClientId;
    this.preferCode = preferCode;
    this.fetchFull = fetchFull ?? (async (item) => {
      const res = await fetch(source(item).url);
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    this.convert = convert;
    this.videoSource = videoSource;
    this.canWrite = canWrite;
    this.fullCache = new Map();
    this.view = null;
    this.screen = 'browse';
    this.items = [];
    this.games = [];
    this.visible = [];
    this.kind = initial.kind ?? 'all';
    this.query = initial.game ?? '';
    this.gameIndex = 0;
    this.gameScroll = 0;
    this.itemIndex = 0;
    this.itemScroll = 0;
    this.focus = 'items';
    this.selected = new Set();
    this.local = new Set();
    this.mode = 'normal';
    this.loading = true;
    this.error = null;
    this.status = null;
    this.downloading = null;
    this.showImages = true;
    this.cell = { w: 8, h: 16 };
    this.panes = [];
    this.prev = [];
    this.plan = null;
    this.imageKey = null;
    this.imageArea = null;
    this.sent = new Set();
    this.imageIds = new Map();
    this.closed = false;
    this.done = new Promise((r) => {
      this.finish = r;
    });
  }

  // ---- data ----

  async start() {
    if (this.initialLogin && this.auth) return this.showLogin(this.initialLogin);
    await this.load();
  }

  startSpinner() {
    clearInterval(this.spinner);
    this.spinFrame = 0;
    this.spinner = setInterval(() => {
      this.spinFrame++;
      this.render();
    }, 100);
  }

  async load() {
    this.screen = 'browse';
    this.loading = true;
    this.error = null;
    this.startSpinner();
    this.render();
    try {
      const { items, gamertag, xuid } = await this.loadData();
      this.items = items;
      this.gamertag = gamertag;
      this.xuid = xuid;
      const ids = new Set(items.map((i) => i.id));
      for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
    } catch (e) {
      if (e.auth && this.auth) {
        clearInterval(this.spinner);
        this.loading = false;
        return this.showLogin({ clientId: e.clientId, error: e.message });
      }
      this.error = e.message;
    }
    clearInterval(this.spinner);
    this.loading = false;
    this.recompute();
    this.render();
    if (!this.error && this.shouldCheckLocal) await this.checkLocal();
  }

  async checkLocal() {
    await runPool(this.items, 16, async (item) => {
      const { size } = source(item, { hdr: this.hdr });
      try {
        const s = await stat(targetPath(this.outDir, item, { hdr: this.hdr }));
        if (s.size > 0 && (!size || s.size === size)) this.local.add(item.id);
      } catch {
        // Not downloaded.
      }
    });
    this.render();
  }

  recompute() {
    const q = this.query.toLowerCase();
    const base = this.items.filter((i) => (this.kind === 'all' || i.kind === this.kind) && (!q || i.game.toLowerCase().includes(q)));
    const prevGame = this.games[this.gameIndex]?.game;
    const prevItem = this.current()?.id;
    this.games = [
      { game: null, label: 'All games', count: base.length },
      ...summarizeGames(base).map((g) => ({ game: g.game, label: g.game, count: g.screenshots + g.clips })),
    ];
    this.gameIndex = Math.max(0, this.games.findIndex((g) => g.game === prevGame));
    const game = this.games[this.gameIndex].game;
    this.visible = game == null ? base : base.filter((i) => i.game === game);
    this.itemIndex = Math.max(0, this.visible.findIndex((i) => i.id === prevItem));
  }

  current() {
    return this.visible[this.itemIndex];
  }

  // ---- input ----

  input(str) {
    for (const ev of parseInput(str)) this.handle(ev);
    this.render();
  }

  resize() {
    this.prev = [];
    this.imageKey = null;
    this.closePlayer(true);
    this.write(`\x1b[2J${this.protocol === 'kitty' ? kittyClear : ''}`);
    this.render();
  }

  handle(ev) {
    if (ev.name === 'cellsize') {
      this.cell = { w: ev.w, h: ev.h };
      return;
    }
    if (ev.ctrl && ev.name === 'c') return this.quit(true);
    if (this.screen === 'login') return this.loginKey(ev);
    if (this.loading) return ev.name === 'q' ? this.quit(true) : undefined;
    if (ev.name === 'mouse') return this.mouse(ev);
    if (this.mode === 'help') {
      this.mode = 'normal';
      return;
    }
    if (this.mode === 'filter') return this.filterKey(ev);
    if (this.mode === 'view') return this.viewKey(ev);
    if (this.mode === 'account') return this.accountKey(ev);
    if (this.error) {
      if (ev.name === 'r') this.load();
      if (ev.name === 'q' || ev.name === 'escape') this.quit(true);
      return;
    }
    if (ev.name !== 'q') this.confirmQuit = false;
    if (ev.ctrl) {
      if (ev.name === 'u') this.move(-this.page());
      if (ev.name === 'd') this.move(this.page());
      return;
    }
    switch (ev.name) {
      case 'q':
        return this.quit();
      case 'up':
      case 'k':
        return this.move(-1);
      case 'down':
      case 'j':
        return this.move(1);
      case 'pageup':
        return this.move(-this.page());
      case 'pagedown':
        return this.move(this.page());
      case 'home':
      case 'g':
        return this.move(-Infinity);
      case 'end':
      case 'G':
        return this.move(Infinity);
      case 'left':
      case 'h':
        this.focus = 'games';
        return;
      case 'right':
      case 'l':
        this.focus = 'items';
        return;
      case 'tab':
      case 'backtab':
        this.focus = this.focus === 'games' ? 'items' : 'games';
        return;
      case 'enter':
        if (this.focus === 'games') this.focus = 'items';
        else this.openViewer();
        return;
      case 'v':
        return this.openViewer();
      case 'o':
        return this.open();
      case 'y':
        return this.copyLinks();
      case ' ':
        return this.toggleSelect();
      case 'a':
        return this.selectAll();
      case 'escape':
        if (this.selected.size) this.selected.clear();
        else if (this.query) {
          this.query = '';
          this.recompute();
        }
        return;
      case 'd':
        this.downloadSelection();
        return;
      case 't': {
        const i = KIND_TABS.findIndex(([k]) => k === this.kind);
        this.kind = KIND_TABS[(i + 1) % KIND_TABS.length][0];
        this.recompute();
        return;
      }
      case '/':
        this.mode = 'filter';
        this.queryBefore = this.query;
        return;
      case 'p':
        this.showImages = !this.showImages;
        return;
      case 'r':
        this.load();
        return;
      case '?':
        this.mode = 'help';
        return;
      case 'L':
        if (!this.auth) return this.flash('Demo mode has no account.', true);
        this.mode = 'account';
        return;
    }
  }

  accountKey(ev) {
    this.mode = 'normal';
    if (ev.name === 's') this.signOut({ switchUser: true });
    else if (ev.name === 'o') this.signOut();
  }

  // ---- viewer ----

  openViewer() {
    const item = this.current();
    if (!item) return;
    if (!this.protocol) {
      return this.flash('Inline viewing needs kitty, Ghostty, WezTerm or iTerm2. Press o to open the capture in your browser.', true);
    }
    this.mode = 'view';
    this.view = { item };
    if (item.kind !== 'clip') this.loadFull(item);
  }

  closeViewer() {
    this.closePlayer();
    this.mode = 'normal';
    this.view = null;
    this.prev = [];
  }

  /** Stops the clip. With keep, the next render starts a new player at the same time (after a resize). */
  closePlayer(keep = false) {
    const player = this.view?.player;
    if (!player) return;
    player.close();
    this.view.player = null;
    if (keep) this.view.resume = { pos: player.pos, playing: player.playing, muted: player.muted };
  }

  viewStep(delta) {
    const next = clamp(this.itemIndex + delta, 0, this.visible.length - 1);
    if (next === this.itemIndex) return;
    this.closePlayer();
    this.itemIndex = next;
    this.view = { item: this.current() };
    if (this.view.item.kind !== 'clip') this.loadFull(this.view.item);
  }

  viewKey(ev) {
    const { item, player } = this.view;
    const clip = item.kind === 'clip';
    switch (ev.name) {
      case 'escape':
      case 'q':
      case 'v':
        return this.closeViewer();
      case '[':
      case 'pageup':
      case 'k':
      case 'up':
        return this.viewStep(-1);
      case ']':
      case 'pagedown':
      case 'j':
      case 'down':
        return this.viewStep(1);
      case 'left':
        return clip ? player?.seek(-5) : this.viewStep(-1);
      case 'right':
        return clip ? player?.seek(5) : this.viewStep(1);
      case ' ':
        return player?.toggle();
      case 'home':
      case '0':
        return player?.seek(-Infinity);
      case 'm':
        return player?.toggleMute();
      case 'y':
        return this.copyLinks([item]);
      case 'd':
        return this.downloadSelection([item]);
      case 'o':
        return this.open(item);
    }
  }

  async loadFull(item) {
    if (this.fullCache.has(item.id)) return;
    const entry = { status: 'loading' };
    this.fullCache.set(item.id, entry);
    if (this.fullCache.size > 6) this.fullCache.delete(this.fullCache.keys().next().value);
    try {
      const raw = this.local.has(item.id)
        ? await readFile(targetPath(this.outDir, item, { hdr: this.hdr })).catch(() => this.fetchFull(item))
        : await this.fetchFull(item);
      let data = raw;
      if (!isPng(raw) || raw.length > 4_000_000) {
        data = await this.convert(raw, 2400).catch(() => (this.protocol === 'iterm' || isPng(raw) ? raw : null));
      }
      if (!data) throw new Error('Could not convert the image to PNG (install ImageMagick or ffmpeg).');
      Object.assign(entry, { status: 'ready', data, ...(pngSize(data) ?? { width: item.width, height: item.height }) });
    } catch (e) {
      Object.assign(entry, { status: 'error', error: e.message });
    }
    if (this.view?.item.id === item.id) this.render();
  }

  /** ffmpeg and ffplay inputs for a clip: the downloaded file when there is one, else the Xbox link. */
  clipSource(item) {
    if (this.videoSource) return this.videoSource(item);
    const where = this.local.has(item.id) ? targetPath(this.outDir, item, { hdr: false }) : source(item).url;
    return {
      input: (from) => ['-ss', String(from), '-i', where],
      audio: (from) => ['-ss', String(from), where],
    };
  }

  // ---- links ----

  async copyLinks(list) {
    const items =
      list ?? (this.selected.size ? this.items.filter((i) => this.selected.has(i.id)) : [this.current()].filter(Boolean));
    const urls = items.map((i) => source(i, { hdr: this.hdr }).url).filter(Boolean);
    if (!urls.length) return this.flash(this.demo ? 'Demo captures have no link.' : 'This capture has no link.', true);
    try {
      await this.copy(urls.join('\n'));
    } catch (e) {
      return this.flash(`Could not copy: ${e.message}`, true);
    }
    const until = linkExpiry(urls[0]);
    const what = urls.length === 1 ? 'the link' : `${urls.length} links`;
    this.flash(`Copied ${what}. ${until ? `Xbox links stop working at ${until}.` : 'Xbox links are temporary.'}`);
    this.render();
  }

  filterKey(ev) {
    if (ev.name === 'enter') {
      this.mode = 'normal';
      return;
    }
    if (ev.name === 'escape') {
      this.mode = 'normal';
      this.query = this.queryBefore ?? '';
    } else if (ev.name === 'backspace') {
      this.query = [...this.query].slice(0, -1).join('');
    } else if (ev.ctrl && ev.name === 'u') {
      this.query = '';
    } else if (ev.char) {
      this.query += ev.char;
    } else {
      return;
    }
    this.recompute();
  }

  page() {
    return Math.max(1, this.size().rows - 5);
  }

  move(delta, kind = this.focus) {
    if (kind === 'games') {
      const next = clamp(this.gameIndex + delta, 0, this.games.length - 1);
      if (next !== this.gameIndex) {
        this.gameIndex = next;
        this.itemIndex = 0;
        this.itemScroll = 0;
        this.recompute();
      }
    } else if (this.visible.length) {
      this.itemIndex = clamp(this.itemIndex + delta, 0, this.visible.length - 1);
    }
  }

  mouse(ev) {
    if (this.mode !== 'normal' || this.error) return;
    const p = this.panes.find((q) => ev.x >= q.x && ev.x < q.x + q.w && ev.y >= q.y && ev.y < q.y + q.h);
    if (!p || p.kind === 'preview') return;
    if (ev.action === 'wheelup' || ev.action === 'wheeldown') return this.move(ev.action === 'wheelup' ? -3 : 3, p.kind);
    if (ev.action !== 'press') return;
    const row = ev.y - p.y - 1;
    if (row < 0 || row >= p.h - 2) return;
    this.focus = p.kind;
    if (p.kind === 'games') {
      const idx = this.gameScroll + row;
      if (idx < this.games.length) this.move(idx - this.gameIndex, 'games');
    } else {
      const idx = this.itemScroll + row;
      if (idx >= this.visible.length) return;
      this.itemIndex = idx;
      if (ev.x - p.x <= 3) this.toggleSelect(false);
    }
  }

  toggleSelect(advance = true) {
    if (this.focus === 'games') {
      const game = this.games[this.gameIndex]?.game;
      const q = this.query.toLowerCase();
      const list = this.items.filter(
        (i) => (game == null || i.game === game) && (this.kind === 'all' || i.kind === this.kind) && (!q || i.game.toLowerCase().includes(q)),
      );
      const all = list.length && list.every((i) => this.selected.has(i.id));
      for (const i of list) all ? this.selected.delete(i.id) : this.selected.add(i.id);
      return;
    }
    const item = this.current();
    if (!item) return;
    if (this.selected.has(item.id)) this.selected.delete(item.id);
    else this.selected.add(item.id);
    if (advance) this.move(1);
  }

  selectAll() {
    const all = this.visible.length && this.visible.every((i) => this.selected.has(i.id));
    for (const i of this.visible) all ? this.selected.delete(i.id) : this.selected.add(i.id);
  }

  flash(text, error = false) {
    this.status = { text, error, until: Date.now() + 4000 };
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.render(), 4100);
  }

  async open(item = this.current()) {
    if (!item) return;
    try {
      await this.openUrl(source(item, { hdr: this.hdr }).url);
      this.flash(`Opened ${item.game} ${item.kind === 'clip' ? 'clip' : 'screenshot'} in your browser.`);
    } catch (e) {
      this.flash(`Could not open: ${e.message}`, true);
    }
    this.render();
  }

  async downloadSelection(only) {
    if (this.downloading) return this.flash('A download is already running.', true);
    const ids = only ? new Set(only.map((i) => i.id)) : this.selected.size ? this.selected : new Set([this.current()?.id].filter(Boolean));
    const list = this.items.filter((i) => ids.has(i.id));
    if (!list.length) return;
    const state = { total: list.length, done: 0, saved: 0, skipped: 0, failed: 0 };
    this.downloading = state;
    this.render();
    await runPool(list, this.jobs, async (item) => {
      try {
        const r = await this.download(item, targetPath(this.outDir, item, { hdr: this.hdr }));
        if (r.status === 'skipped') state.skipped++;
        else state.saved++;
        this.local.add(item.id);
        this.selected.delete(item.id);
      } catch {
        state.failed++;
      }
      state.done++;
      this.render();
    });
    this.downloading = null;
    const where = relative(process.cwd(), this.outDir) || '.';
    const msg = `Saved ${state.saved}, ${state.skipped} already there, ${state.failed} failed → ${where}`;
    this.flash(state.failed ? `${msg}. Press d again to retry.` : msg, state.failed > 0);
    this.render();
  }

  quit(force = false) {
    if (this.downloading && !force && !this.confirmQuit) {
      this.confirmQuit = true;
      this.flash('Downloads are running. Press q again to quit.', true);
      return;
    }
    this.closePlayer();
    this.closed = true;
    this.loginAbort?.abort();
    clearInterval(this.spinner);
    clearTimeout(this.statusTimer);
    clearTimeout(this.previewTimer);
    this.finish(0);
  }

  // ---- sign-in ----

  showLogin({ clientId = '', error = null, auto = false } = {}) {
    this.screen = 'login';
    this.loading = false;
    this.mode = 'normal';
    const id = clientId || this.defaultClientId || '';
    const message = error?.replace(/\s*Run "xbmg login"( again| first)?\./, '').trim() || null;
    this.loginState = {
      step: id ? 'ready' : 'clientId',
      clientId: id,
      input: id && id !== this.defaultClientId ? id : '',
      error: message,
      hint: authHint(message ?? ''),
    };
    this.startSpinner();
    if (auto && CLIENT_ID_RE.test(id)) this.startLogin();
    this.render();
  }

  async startLogin(method = this.preferCode ? 'code' : 'browser') {
    const s = this.loginState;
    if (s.step === 'clientId') {
      const typed = s.input.trim().toLowerCase();
      if (!CLIENT_ID_RE.test(typed)) {
        s.error = 'That is not a client ID. It looks like 1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f.';
        s.hint = null;
        return;
      }
      s.clientId = typed;
    }
    const clientId = s.clientId;
    this.loginAbort?.abort();
    const ctrl = new AbortController();
    this.loginAbort = ctrl;
    Object.assign(s, { step: 'starting', method, error: null, hint: null, copied: false, url: null });
    this.render();
    const live = () => !ctrl.signal.aborted && !this.closed;
    try {
      const { gamertag } = await this.auth.login(clientId, {
        method,
        signal: ctrl.signal,
        onUrl: async (url) => {
          if (!live()) return;
          Object.assign(s, { step: 'browser', url });
          this.render();
          await this.openLink(url);
        },
        onCode: ({ userCode, verificationUri, expiresIn }) => {
          if (!live()) return;
          Object.assign(s, { step: 'code', userCode, verificationUri, expiresAt: Date.now() + expiresIn * 1000 });
          this.copyText(userCode);
          this.render();
        },
        onVerify: () => {
          if (!live()) return;
          s.step = 'verifying';
          this.render();
        },
      });
      if (!live()) return;
      this.loginAbort = null;
      this.flash(`Signed in as ${gamertag ?? 'unknown gamertag'}.`);
      await this.load();
    } catch (e) {
      if (!live()) return;
      Object.assign(s, { step: 'ready', error: e.message, hint: authHint(e.message) });
      this.render();
    }
  }

  async copyText(text) {
    const s = this.loginState;
    try {
      await this.copy(text);
      s.copied = true;
    } catch {
      s.copied = false;
    }
    this.render();
  }

  cancelLogin() {
    this.loginAbort?.abort();
    this.loginAbort = null;
    this.loginState.step = 'ready';
  }

  loginKey(ev) {
    const s = this.loginState;
    if (s.step === 'clientId') {
      if (ev.name === 'enter') return this.startLogin();
      if (ev.name === 'escape') {
        if (!s.clientId) return this.quit(true);
        s.step = 'ready';
        s.error = null;
        s.hint = null;
        return;
      }
      if (ev.ctrl && ev.name === 'o') return this.openLink(PORTAL_URL);
      if (ev.ctrl && ev.name === 'u') s.input = '';
      else if (ev.name === 'backspace') s.input = s.input.slice(0, -1);
      else if (ev.char && /[0-9a-f-]/i.test(ev.char) && s.input.length < 36) s.input += ev.char;
      else return;
      s.error = null;
      s.hint = null;
      return;
    }
    if (s.step === 'ready') {
      if (ev.name === 'enter' || ev.name === 'o') return this.startLogin('browser');
      if (ev.name === 'd') return this.startLogin('code');
      if (ev.name === 'i') {
        Object.assign(s, { step: 'clientId', error: null, hint: null });
        return;
      }
      if (ev.name === 'escape' || ev.name === 'q') return this.quit(true);
      return;
    }
    if (ev.name === 'escape') return this.cancelLogin();
    if (ev.name === 'q') return this.quit(true);
    if (s.step === 'browser') {
      if (ev.name === 'enter' || ev.name === 'o') this.openLink(s.url);
      else if (ev.name === 'c') this.copyText(s.url);
      else if (ev.name === 'd') this.startLogin('code');
    } else if (s.step === 'code') {
      if (ev.name === 'enter' || ev.name === 'o') {
        this.copyText(s.userCode);
        this.openLink(s.verificationUri);
      } else if (ev.name === 'c') {
        this.copyText(s.userCode);
      }
    }
  }

  async openLink(url) {
    try {
      await this.openUrl(url);
    } catch (e) {
      this.flash(`Could not open the browser: ${e.message}. Open ${url} yourself.`, true);
      this.render();
    }
  }

  async signOut({ switchUser = false } = {}) {
    if (this.downloading) return this.flash('Wait for the downloads to finish first.', true);
    const clientId = await this.auth.signOut();
    const who = this.gamertag;
    this.items = [];
    this.selected.clear();
    this.local.clear();
    this.gamertag = null;
    this.xuid = null;
    this.recompute();
    this.showLogin({ clientId });
    if (switchUser) this.startLogin('browser');
    else this.flash(who ? `Signed out of ${who}.` : 'Signed out.');
  }

  // ---- previews ----

  queuePreview(item) {
    clearTimeout(this.previewTimer);
    if (!item || !this.protocol || !this.thumbs) return;
    const entry = this.thumbs.peek(item.id);
    if (entry && entry.status !== 'loading') return;
    this.previewTimer = setTimeout(async () => {
      await this.thumbs.get(item);
      if (this.current()?.id === item.id) this.render();
      const next = this.visible.slice(this.itemIndex + 1, this.itemIndex + 3);
      for (const n of next) await this.thumbs.get(n);
    }, 90);
  }

  numericId(id) {
    if (!this.imageIds.has(id)) this.imageIds.set(id, this.imageIds.size + 1);
    return this.imageIds.get(id);
  }

  // ---- drawing ----

  layout(cols, rows) {
    const y = 1;
    const h = rows - 2;
    if (cols >= 100) {
      const gw = clamp(Math.round(cols * 0.2), 22, 32);
      const iw = clamp(Math.round(cols * 0.36), 40, 64);
      return [
        { kind: 'games', x: 0, y, w: gw, h },
        { kind: 'items', x: gw, y, w: iw, h },
        { kind: 'preview', x: gw + iw, y, w: cols - gw - iw, h },
      ];
    }
    const list = this.focus === 'games' ? 'games' : 'items';
    if (cols >= 64) {
      const lw = clamp(Math.round(cols * 0.5), 32, 50);
      return [
        { kind: list, x: 0, y, w: lw, h },
        { kind: 'preview', x: lw, y, w: cols - lw, h },
      ];
    }
    return [{ kind: list, x: 0, y, w: cols, h }];
  }

  frame() {
    const { cols, rows } = this.size();
    this.plan = null;
    this.panes = [];
    if (cols < 40 || rows < 10) {
      const lines = Array.from({ length: rows }, () => ' '.repeat(cols));
      lines[Math.floor(rows / 2)] = centered('Make the window larger', cols, S.yellow);
      return lines;
    }
    const lines = [this.header(cols)];
    const h = rows - 2;
    if (this.screen === 'login') {
      lines.push(...this.loginBody(cols, h));
    } else if (this.mode === 'view' && this.view) {
      lines.push(...this.viewBody(cols, h));
    } else if (this.mode === 'account') {
      lines.push(...this.accountBody(cols, h));
    } else if (this.loading || this.error || this.mode === 'help') {
      const body = this.loading ? this.loadingBody(cols, h) : this.error ? this.errorBody(cols, h) : this.helpBody(cols, h);
      lines.push(...body);
    } else {
      this.panes = this.layout(cols, rows);
      const drawn = this.panes.map((p) => this.pane(p));
      for (let r = 0; r < h; r++) lines.push(drawn.map((d) => d[r]).join(''));
    }
    lines.push(this.footer(cols));
    return lines;
  }

  render() {
    if (this.closed) return;
    const cur = this.current();
    if (!this.loading && cur?.id !== this.lastId) {
      this.lastId = cur?.id;
      this.queuePreview(cur);
    }
    this.flush(this.frame());
  }

  flush(lines) {
    const plan = this.plan;
    const key = plan && `${plan.id}:${plan.row}:${plan.col}:${plan.cols}:${plan.rows}`;
    if (this.protocol === 'iterm' && key !== this.imageKey && this.imageArea) {
      for (let r = this.imageArea[0]; r < this.imageArea[1]; r++) this.prev[r] = null;
    }
    let out = '\x1b[?2026h';
    const changed = [];
    for (let r = 0; r < lines.length; r++) {
      if (lines[r] === this.prev[r]) continue;
      out += `\x1b[${r + 1};1H${lines[r]}`;
      changed.push(r);
    }
    this.prev = lines;
    const touched = plan && changed.some((r) => r >= plan.row && r < plan.row + plan.rows);
    if (plan?.external) {
      // A video player draws this area itself. Remove other images once, then let it redraw.
      const fresh = key !== this.imageKey;
      if (fresh && this.protocol === 'kitty') out += kittyClear;
      this.imageKey = key;
      this.imageArea = [plan.row, plan.row + plan.rows];
      this.write(`${out}\x1b[?2026l`);
      if ((fresh || touched) && !plan.player.playing) plan.player.redraw();
      return;
    }
    if (!plan) {
      if (this.imageKey && this.protocol === 'kitty') out += kittyClear;
      this.imageKey = null;
      this.imageArea = null;
    } else if (key !== this.imageKey || touched) {
      const at = `\x1b[${plan.row + 1};${plan.col + 1}H`;
      if (this.protocol === 'kitty') {
        const id = this.numericId(plan.id);
        out += kittyClear;
        if (this.sent.size > 200) {
          out += kittyFree;
          this.sent.clear();
        }
        if (!this.sent.has(id)) {
          out += kittyTransmit(id, plan.entry.data);
          this.sent.add(id);
        }
        out += at + kittyPlace(id, plan.cols, plan.rows);
      } else {
        out += at + itermImage(plan.entry.data, plan.cols, plan.rows);
      }
      this.imageKey = key;
      this.imageArea = [plan.row, plan.row + plan.rows];
    }
    this.write(`${out}\x1b[?2026l`);
  }

  header(cols) {
    const l = new Line(cols, S.header);
    l.add(' xbmg ', S.brand).add(' ');
    if (this.demo) l.add('DEMO ', S.yellow);
    if (this.gamertag) l.add('Signed in as ', S.dim).add(this.gamertag, S.green).add('  ');
    else if (this.screen === 'login') l.add('Not signed in', S.dim);
    if (!this.loading && this.screen === 'browse') l.add(`${this.items.length} captures`, S.dim);
    if (this.selected.size) l.add(`  ${this.selected.size} selected`, S.pink);
    if (this.query && this.mode !== 'filter') l.add(`  filter: ${this.query}`, S.yellow);
    const tabs = KIND_TABS.map(([k, label]) => [k, ` ${label} `]);
    const tw = tabs.reduce((n, [, t]) => n + strWidth(t), 0) + 1;
    if (this.screen === 'browse' && l.room > tw) {
      l.add('', '', l.room - tw);
      for (const [k, t] of tabs) l.add(t, k === this.kind ? S.tabOn : S.tabOff);
    }
    return l.done();
  }

  footer(cols) {
    const l = new Line(cols);
    if (this.screen === 'login') {
      if (this.status && Date.now() < this.status.until) {
        return l.add(` ${this.status.text}`, this.status.error ? S.red : S.green).done();
      }
      l.add(' ');
      const st = this.loginState;
      for (const [k, label] of LOGIN_HINTS[st.step] ?? LOGIN_HINTS.other) {
        const text = st.step === 'clientId' && k === 'Esc' && !st.clientId ? 'quit' : label;
        l.add(k, S.accent).add(` ${text}  `, S.dim);
      }
      return l.done();
    }
    if (this.mode === 'filter') {
      l.add(' / ', S.accentBold).add(this.query).add('▏', S.accent);
      const hint = 'Enter keep · Esc cancel ';
      if (l.room > hint.length) l.add('', '', l.room - hint.length).add(hint, S.dim);
      return l.done();
    }
    if (this.downloading) {
      const d = this.downloading;
      const barW = 20;
      const filled = Math.round((d.done / d.total) * barW);
      l.add(' Downloading ', S.accentBold)
        .add('█'.repeat(filled), S.accent)
        .add('░'.repeat(barW - filled), S.border)
        .add(` ${d.done}/${d.total}`);
      if (d.failed) l.add(`  ${d.failed} failed`, S.red);
      return l.done();
    }
    if (this.status && Date.now() < this.status.until) {
      return l.add(` ${this.status.text}`, this.status.error ? S.red : S.green).done();
    }
    l.add(' ');
    const hints =
      this.mode === 'view' && this.view
        ? VIEW_HINTS[this.view.item.kind === 'clip' ? 'clip' : 'screenshot']
        : this.mode === 'account'
          ? [
              ['s', 'different user'],
              ['o', 'sign out'],
              ['Esc', 'close'],
            ]
          : HINTS;
    for (const [k, label] of hints) {
      if (l.room < strWidth(k) + strWidth(label) + 3) break;
      l.add(k, S.accent).add(` ${label}  `, S.dim);
    }
    return l.done();
  }

  loadingBody(cols, h) {
    const lines = Array.from({ length: h }, () => ' '.repeat(cols));
    const spin = SPINNER[(this.spinFrame ?? 0) % SPINNER.length];
    lines[Math.floor(h / 2)] = centered(`${spin} Fetching captures from Xbox…`, cols, S.accent);
    return lines;
  }

  errorBody(cols, h) {
    const msg = [
      ['Could not load your captures.', S.red],
      ['', ''],
      ...wrap(this.error, Math.min(cols - 4, 72)).map((t) => [t, '']),
      ['', ''],
      ['Press r to try again, or q to quit.', S.dim],
    ];
    const lines = Array.from({ length: h }, () => ' '.repeat(cols));
    const top = Math.max(0, Math.floor((h - msg.length) / 2));
    msg.forEach(([t, st], i) => {
      if (top + i < h) lines[top + i] = centered(t, cols, st);
    });
    return lines;
  }

  accountBody(cols, h) {
    const w = Math.min(cols - 2, 60);
    const iw = w - 2;
    const blank = ' '.repeat(iw);
    const lines = [
      blank,
      new Line(iw).add(' Signed in as ').add(this.gamertag ?? 'unknown gamertag', S.green).done(),
      ...(this.xuid ? [new Line(iw).add(` Xbox user ID ${this.xuid}`, S.dim).done()] : []),
      blank,
      new Line(iw).add(' s', S.accentBold).add('    Sign in as a different user').done(),
      new Line(iw).add(' o', S.accentBold).add('    Sign out').done(),
      blank,
      new Line(iw).add(' Esc  Close', S.dim).done(),
      blank,
    ];
    return centerBox(lines, w, cols, h, 'Account');
  }

  viewBody(cols, h) {
    const { item } = this.view;
    const clip = item.kind === 'clip';
    const iw = cols - 2;
    const imgRows = Math.max(1, h - 4);
    const blank = ' '.repeat(iw);
    const content = Array.from({ length: imgRows }, () => blank);
    const mid = Math.floor(imgRows / 2);
    // Screen rows: 0 is the header, 1 the top border, so the image area starts at row 2 and column 2.
    const place = (pxW, pxH) => {
      const f = fitCells(pxW, pxH, iw - 2, imgRows, this.cell.w, this.cell.h);
      return { row: 2 + Math.floor((imgRows - f.rows) / 2), col: 2 + Math.floor((iw - 2 - f.cols) / 2), ...f };
    };
    let status;
    if (clip) {
      const pxW = item.width || 1920;
      const pxH = item.height || 1080;
      let player = this.view.player;
      if (!player) {
        const at = place(pxW, pxH);
        const w = even(Math.min(VIDEO_WIDTH, at.cols * this.cell.w));
        const src = this.clipSource(item);
        player = new VideoPlayer({
          input: src.input,
          audio: src.audio,
          protocol: this.protocol,
          write: this.write,
          canWrite: this.canWrite,
          box: at,
          size: { w, h: even((w * pxH) / pxW) },
          duration: item.duration || 30,
          onChange: () => this.render(),
        });
        const resume = this.view.resume;
        this.view.resume = null;
        if (resume) Object.assign(player, { pos: resume.pos, muted: resume.muted });
        this.view.player = player;
        setImmediate(() => {
          if (this.view?.player !== player) return;
          if (!resume || resume.playing) player.play();
          else player.seek(0);
        });
      }
      this.plan = { external: true, player, id: `video:${item.id}`, ...player.box };
      if (player.error) content[mid] = centered(player.error, iw, S.red);
      else if (!player.last) content[mid] = centered('Loading video…', iw, S.dim);
      status = this.clipStatus(player, iw);
    } else {
      const entry = this.fullCache.get(item.id);
      if (entry?.status === 'ready') this.plan = { id: `full:${item.id}`, entry, ...place(entry.width, entry.height) };
      else if (entry?.status === 'error') content[mid] = centered(entry.error, iw, S.red);
      else content[mid] = centered('Loading image…', iw, S.dim);
      const l = new Line(iw).add(' ').add(item.width && item.height ? `${item.width} × ${item.height}` : '', S.dim);
      l.add(`   ${formatBytes(source(item, { hdr: this.hdr }).size)}`, S.dim);
      if (item.hdrUrl) l.add('   HDR', S.yellow);
      if (this.local.has(item.id)) l.add('   ✓ saved', S.green);
      status = l.done();
    }
    content.push(blank, status);
    const title = `${item.game} · ${clip ? 'Game clip' : 'Screenshot'} · ${formatDate(item.date)}`;
    return box(content, cols, h, { title, right: `${this.itemIndex + 1}/${this.visible.length}`, focused: true });
  }

  clipStatus(p, iw) {
    const icon = p.playing ? '▶' : p.ended ? '■' : '❚❚';
    const flags = p.noSound ? 'no sound' : p.muted ? 'muted' : '';
    const l = new Line(iw).add(' ').add(icon, S.accentBold).add(` ${mmss(p.pos)} / ${mmss(p.duration)}  `);
    const barW = Math.max(0, l.room - strWidth(flags) - 3);
    const filled = Math.round(Math.min(1, p.pos / (p.duration || 1)) * barW);
    l.add('━'.repeat(filled), S.accent).add('─'.repeat(barW - filled), S.border);
    if (flags) l.add(`  ${flags}`, S.dim);
    return l.done();
  }

  helpBody(cols, h) {
    const w = Math.min(cols - 2, 76);
    const keyW = 20;
    const content = HELP.map(([k, d]) => new Line(w - 2).add(' ').add(k, S.accent, keyW).add(d).done());
    content.push(' '.repeat(w - 2), new Line(w - 2).add(' Press any key to close.', S.dim).done());
    return centerBox(content, w, cols, h, 'Keys');
  }

  loginBody(cols, h) {
    const s = this.loginState;
    const w = Math.min(cols - 2, 78);
    const iw = w - 2;
    const blank = ' '.repeat(iw);
    const text = (t, st = '', indent = 1) =>
      wrap(t, iw - indent - 1).map((x) => new Line(iw).add(' '.repeat(indent)).add(x, st).done());
    const spin = SPINNER[(this.spinFrame ?? 0) % SPINNER.length];
    const waiting = (msg) => new Line(iw).add(` ${spin} `, S.accent).add(msg).done();
    const lines = [blank];
    const problems = () => {
      if (s.error) lines.push(...text(s.error, S.red));
      if (s.hint) lines.push(...text(s.hint, S.yellow));
      if (s.error || s.hint) lines.push(blank);
    };

    if (s.step === 'clientId') {
      lines.push(...text('Type or paste the Application (client) ID of your Azure app registration.'));
      lines.push(blank);
      const field = new Line(iw).add(' ').add('Client ID  ', S.bold).add(' ', S.field);
      field.add(s.input, S.field).add('▏', S.fieldCursor).add(' '.repeat(Math.max(0, 36 - s.input.length)), S.field).add(' ', S.field);
      lines.push(field.done(), blank);
      problems();
      lines.push(...text('No app registration yet? Press Ctrl-O to open the Microsoft Entra portal, then:', S.bold));
      for (const step of [
        '1. App registrations → New registration.',
        '2. Account types: Personal Microsoft accounts only → Register.',
        '3. Authentication → Add a platform → Mobile and desktop applications. Add the redirect URI http://localhost.',
        '4. Set "Allow public client flows" to Yes → Save.',
        '5. Overview → copy the Application (client) ID.',
      ]) {
        const [num, ...rest] = step.split(' ');
        const body = wrap(rest.join(' '), iw - 7);
        body.forEach((t, i) => lines.push(new Line(iw).add(i ? '      ' : `   ${num} `).add(t).done()));
      }
      lines.push(...text('You do not need a client secret or API permissions.', S.dim, 3));
    } else if (s.step === 'ready') {
      lines.push(...text('You are not signed in.', S.bold));
      lines.push(...text('Sign in with the Microsoft account that has your Xbox profile.'));
      lines.push(blank);
      problems();
      lines.push(new Line(iw).add(' Press ').add('Enter', S.accentBold).add(' to sign in with your web browser.').done());
      if (s.clientId !== this.defaultClientId) {
        lines.push(blank, new Line(iw).add(` Client ID ${s.clientId}. Press i to change it.`, S.dim).done());
      }
    } else if (s.step === 'browser') {
      lines.push(waiting('Waiting for you to sign in in your web browser…'), blank);
      lines.push(...text('Your browser shows the Microsoft sign-in page. Sign in with the account that has your Xbox profile, then come back here.'));
      lines.push(blank);
      lines.push(...text('Did the browser not open? Press Enter to try again, or c to copy the link.', S.dim));
      lines.push(...text('Does the browser show an error? Press d to sign in with a code instead.', S.dim));
      if (s.copied) lines.push(blank, ...text('The link is on your clipboard.', S.green));
    } else if (s.step === 'code') {
      const left = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));
      lines.push(new Line(iw).add(' 1. Open ').add(s.verificationUri, S.link).done());
      lines.push(new Line(iw).add(' 2. Enter this code:').done(), blank);
      lines.push(centered(` ${s.userCode} `, iw, S.code), blank);
      lines.push(...text('3. Sign in with the Microsoft account that has your Xbox profile.'));
      lines.push(blank);
      lines.push(
        left > 0
          ? new Line(iw).add(` ${spin} `, S.accent).add('Waiting for you to sign in…').add(`   The code expires in ${Math.floor(left / 60)}:${pad2(left % 60)}.`, S.dim).done()
          : new Line(iw).add(' The code expired. Press Esc and try again.', S.red).done(),
      );
      if (s.copied) lines.push(new Line(iw).add(' The code is on your clipboard.', S.green).done());
    } else {
      lines.push(waiting(s.step === 'verifying' ? 'Signing in to Xbox Live…' : 'Starting the sign-in…'));
    }
    lines.push(blank);
    return centerBox(lines, w, cols, h, 'Sign in to Xbox');
  }

  pane(p) {
    const iw = p.w - 2;
    const ih = p.h - 2;
    const focused = this.focus === p.kind;
    if (p.kind === 'games') {
      return box(this.gameLines(iw, ih, focused), p.w, p.h, {
        title: 'Games',
        right: `${this.gameIndex + 1}/${this.games.length}`,
        focused,
      });
    }
    if (p.kind === 'items') {
      const game = this.games[this.gameIndex];
      return box(this.itemLines(iw, ih, focused), p.w, p.h, {
        title: game?.game ?? 'All captures',
        right: this.visible.length ? `${this.itemIndex + 1}/${this.visible.length}` : '',
        focused,
      });
    }
    return box(this.previewLines(iw, ih, p.x + 1, p.y + 1), p.w, p.h, { title: 'Preview' });
  }

  gameLines(w, h, focused) {
    this.gameScroll = scrollFor(this.gameIndex, this.gameScroll, h, this.games.length);
    const cw = String(Math.max(...this.games.map((g) => g.count))).length;
    const lines = [];
    for (let r = 0; r < h; r++) {
      const idx = this.gameScroll + r;
      const g = this.games[idx];
      if (!g) break;
      const cur = idx === this.gameIndex;
      const l = new Line(w, cur ? (focused ? S.focusRow : S.row) : '');
      l.add(' ')
        .add(g.label, idx === 0 ? S.bold : '', w - cw - 3)
        .add(' ')
        .add(String(g.count), cur ? '' : S.dim, cw, 'right');
      lines.push(l.done());
    }
    return lines;
  }

  itemLines(w, h, focused) {
    if (!this.visible.length) {
      const lines = Array.from({ length: h }, () => ' '.repeat(w));
      lines[Math.floor(h / 3)] = centered(this.query ? `No captures match "${this.query}"` : 'No captures', w, S.dim);
      return lines;
    }
    this.itemScroll = scrollFor(this.itemIndex, this.itemScroll, h, this.visible.length);
    const showGame = this.games[this.gameIndex]?.game == null;
    const short = w < 46;
    const lines = [];
    for (let r = 0; r < h; r++) {
      const idx = this.itemScroll + r;
      const it = this.visible[idx];
      if (!it) break;
      const cur = idx === this.itemIndex;
      const clip = it.kind === 'clip';
      const l = new Line(w, cur ? (focused ? S.focusRow : S.row) : '');
      l.add(' ')
        .add(this.selected.has(it.id) ? '●' : ' ', S.pink)
        .add(' ')
        .add(clip ? '▶' : '▣', clip ? S.yellow : S.accent)
        .add(' ')
        .add(formatDate(it.date, short));
      const gameW = l.room - 9;
      if (showGame && gameW > 3) l.add('  ').add(it.game, cur ? '' : S.dim, gameW - 2);
      else l.add('', '', Math.max(0, gameW));
      l.add(' ')
        .add(clip ? formatDuration(it.duration) : it.hdrUrl ? 'HDR' : '', clip ? '' : S.yellow, 5, 'right')
        .add(' ')
        .add(this.local.has(it.id) ? '✓' : ' ', S.green);
      lines.push(l.done());
    }
    return lines;
  }

  metaLines(it, w) {
    const saved = this.local.has(it.id);
    const rows = [
      ['Game', it.game, S.bold],
      ...(it.caption ? [['Caption', it.caption, S.italic]] : []),
      ['Type', it.kind === 'clip' ? 'Game clip' : 'Screenshot'],
      ['Captured', formatDate(it.date)],
      ['Resolution', it.width && it.height ? `${it.width} × ${it.height}` : '—'],
      it.kind === 'clip'
        ? ['Length', formatDuration(it.duration) || '—']
        : ['HDR', it.hdrUrl ? `yes${it.hdrSize ? `, ${formatBytes(it.hdrSize)}` : ''}` : 'no'],
      ['Size', formatBytes(source(it, { hdr: this.hdr }).size) || '—'],
      ['ID', it.id ?? '—', S.dim],
      [
        'Saved',
        saved ? relative(process.cwd(), targetPath(this.outDir, it, { hdr: this.hdr })) : 'not downloaded',
        saved ? S.green : S.dim,
      ],
    ];
    return rows.map(([k, v, st = '']) => new Line(w).add(' ').add(k, S.dim, 11).add(v, st, w - 13).done());
  }

  previewLines(w, h, x, y) {
    const blank = ' '.repeat(w);
    const it = this.current();
    if (!it) return [];
    const meta = this.metaLines(it, w);
    const imgH = h - meta.length - 1;
    const lines = [];
    if (this.protocol && this.showImages && imgH >= 4) {
      const entry = this.thumbs?.peek(it.id);
      const ok = entry?.status === 'ready' && (this.protocol === 'iterm' || entry.png);
      for (let r = 0; r < imgH; r++) lines.push(blank);
      if (ok) {
        const box = fitCells(entry.width, entry.height, w - 2, imgH, this.cell.w, this.cell.h);
        this.plan = {
          id: it.id,
          entry,
          row: y + Math.floor((imgH - box.rows) / 2),
          col: x + 1 + Math.floor((w - 2 - box.cols) / 2),
          ...box,
        };
      } else {
        const msg = entry?.status === 'error' ? entry.error : 'Loading preview…';
        lines[Math.floor(imgH / 2)] = centered(msg, w, S.dim);
      }
      lines.push(blank, ...meta);
      return lines;
    }
    lines.push(...meta);
    const note = !this.protocol
      ? 'Image previews need kitty, Ghostty, WezTerm or iTerm2.'
      : !this.showImages
        ? 'Image previews are off. Press p to show them.'
        : '';
    if (note && h - lines.length >= 2) lines.push(blank, ...wrap(note, w - 2).map((t) => new Line(w).add(' ').add(t, S.dim).done()));
    return lines;
  }
}

function realDeps(values, protocol) {
  const filters = {
    since: parseDate(values.since),
    until: parseDate(values.until, { endOfDay: true }),
    limit: values.limit ? Number(values.limit) : undefined,
  };
  return {
    loadData: async () => {
      try {
        const xsts = await getXboxAuth();
        const all = await fetchAll(['screenshot', 'clip']);
        return { gamertag: xsts.gamertag, xuid: xsts.xuid, items: applyFilters(all, filters) };
      } catch (e) {
        if (e instanceof AuthError) {
          e.auth = true;
          e.clientId = (await loadSession().catch(() => null))?.clientId ?? '';
        }
        throw e;
      }
    },
    auth: {
      login: async (clientId, { method, onUrl, onCode, onVerify, signal }) => {
        const ms =
          method === 'code'
            ? await deviceCodeLogin(clientId, (_message, info) => onCode(info), { signal })
            : await browserLogin(clientId, { onUrl, signal });
        onVerify();
        await saveSession({ clientId, ms });
        const xsts = await getXboxAuth({ force: true });
        return { gamertag: xsts.gamertag };
      },
      // Deletes the tokens but keeps the client ID, so the next sign-in needs only the code.
      signOut: async () => {
        const clientId = (await loadSession().catch(() => null))?.clientId ?? '';
        await clearSession();
        if (clientId) await saveSession({ clientId });
        return clientId;
      },
    },
    thumbs: new ThumbCache({ needPng: protocol === 'kitty' }),
    download: (item, dest) => downloadOne(item, dest, { hdr: !!values.hdr }),
  };
}

/** Runs the browser in the current terminal until the user quits. Returns the exit code. */
export async function runBrowser(values, { openUrl }) {
  const { stdin, stdout } = process;
  const protocol = detectImageProtocol();
  const kinds = parseKinds(values.type);
  const deps = values.demo ? (await import('./demo.js')).demoDeps() : realDeps(values, protocol);
  let login = null;
  if (!values.demo) {
    const session = await loadSession().catch(() => null);
    if (!session?.ms?.refreshToken) {
      const given = values['client-id'] || process.env.XBMG_CLIENT_ID || '';
      login = { clientId: given || session?.clientId || '' };
    }
  }
  const browser = new Browser({
    write: (s) => stdout.write(s),
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    openUrl,
    outDir: resolve(values.out),
    hdr: !!values.hdr,
    jobs: Number(values.jobs) || 4,
    protocol,
    initial: { kind: kinds.length === 1 ? kinds[0] : 'all', game: values.game ?? '' },
    login,
    defaultClientId: DEFAULT_CLIENT_ID,
    preferCode: preferDeviceCode(),
    canWrite: () => !stdout.writableNeedDrain,
    // Falls back to OSC 52, which asks the terminal itself to set the clipboard.
    copy: (text) => copyNative(text).catch(() => stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`)),
    ...deps,
  });

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stdout.write(`${protocol === 'kitty' ? kittyFree : ''}\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l`);
    try {
      stdin.setRawMode(false);
    } catch {
      // Not a TTY any more.
    }
    stdin.pause();
  };
  const onData = (s) => browser.input(s);
  const onResize = () => browser.resize();
  const onSignal = () => browser.quit(true);

  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  stdin.resume();
  stdout.on('resize', onResize);
  process.on('exit', restore);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  // Alternate screen, hide cursor, no line wrap, mouse (SGR), then ask for the cell size in pixels.
  stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[16t');

  try {
    browser.start().catch((e) => {
      browser.error = e.message;
      browser.render();
    });
    return await browser.done;
  } finally {
    stdin.off('data', onData);
    stdout.off('resize', onResize);
    process.off('exit', restore);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    restore();
  }
}
