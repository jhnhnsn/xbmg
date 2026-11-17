/** Full-screen browser: games, captures and a preview with an inline image. */

import { stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { downloadOne, runPool, source, targetPath } from '../download.js';
import { applyFilters, parseDate, parseKinds, summarizeGames } from '../filters.js';
import { formatBytes } from '../format.js';
import { ThumbCache, detectImageProtocol, fitCells, itermImage, kittyClear, kittyFree, kittyPlace, kittyTransmit } from './image.js';
import { parseInput } from './keys.js';
import { Line, R, fit, strWidth, style } from './text.js';

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
};

const KIND_TABS = [
  ['all', 'All'],
  ['screenshot', 'Shots'],
  ['clip', 'Clips'],
];

const HINTS = [
  ['↑↓', 'move'],
  ['←→', 'pane'],
  ['space', 'select'],
  ['d', 'download'],
  ['o', 'open'],
  ['t', 'type'],
  ['/', 'filter'],
  ['?', 'help'],
  ['q', 'quit'],
];

const HELP = [
  ['↑ ↓  j k', 'Move in the list'],
  ['PgUp PgDn  ^u ^d', 'Move one page'],
  ['g G  Home End', 'Go to the first or last item'],
  ['← →  h l  Tab', 'Change pane'],
  ['Enter', 'Open the game, or open the capture'],
  ['Space', 'Select a capture (on a game: all its captures)'],
  ['a', 'Select all captures in the list, or none'],
  ['Esc', 'Clear the selection, then the filter'],
  ['d', 'Download the selection (or the current capture)'],
  ['o', 'Open the current capture in your browser'],
  ['t', 'Show all, screenshots or clips'],
  ['/', 'Filter games by name'],
  ['p', 'Show or hide image previews'],
  ['r', 'Fetch the captures again'],
  ['q  Ctrl-C', 'Quit'],
];

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
  }) {
    Object.assign(this, { write, size, loadData, thumbs, download, openUrl, outDir, hdr, jobs, protocol, demo });
    this.shouldCheckLocal = checkLocal;
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
    await this.load();
  }

  async load() {
    this.loading = true;
    this.error = null;
    this.spinFrame = 0;
    this.spinner = setInterval(() => {
      this.spinFrame++;
      this.render();
    }, 100);
    this.render();
    try {
      const { items, gamertag } = await this.loadData();
      this.items = items;
      this.gamertag = gamertag;
      const ids = new Set(items.map((i) => i.id));
      for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
    } catch (e) {
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
    this.write(`\x1b[2J${this.protocol === 'kitty' ? kittyClear : ''}`);
    this.render();
  }

  handle(ev) {
    if (ev.name === 'cellsize') {
      this.cell = { w: ev.w, h: ev.h };
      return;
    }
    if (ev.ctrl && ev.name === 'c') return this.quit(true);
    if (this.loading) return ev.name === 'q' ? this.quit(true) : undefined;
    if (ev.name === 'mouse') return this.mouse(ev);
    if (this.mode === 'help') {
      this.mode = 'normal';
      return;
    }
    if (this.mode === 'filter') return this.filterKey(ev);
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
        else this.open();
        return;
      case 'o':
        return this.open();
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
    }
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

  async open() {
    const item = this.current();
    if (!item) return;
    try {
      await this.openUrl(source(item, { hdr: this.hdr }).url);
      this.flash(`Opened ${item.game} ${item.kind === 'clip' ? 'clip' : 'screenshot'} in your browser.`);
    } catch (e) {
      this.flash(`Could not open: ${e.message}`, true);
    }
    this.render();
  }

  async downloadSelection() {
    if (this.downloading) return this.flash('A download is already running.', true);
    const ids = this.selected.size ? this.selected : new Set([this.current()?.id].filter(Boolean));
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
    this.closed = true;
    clearInterval(this.spinner);
    clearTimeout(this.statusTimer);
    clearTimeout(this.previewTimer);
    this.finish(0);
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
    if (this.loading || this.error || this.mode === 'help') {
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
    if (this.gamertag) l.add(this.gamertag, S.bold).add('  ');
    if (!this.loading) l.add(`${this.items.length} captures`, S.dim);
    if (this.selected.size) l.add(`  ${this.selected.size} selected`, S.pink);
    if (this.query && this.mode !== 'filter') l.add(`  filter: ${this.query}`, S.yellow);
    const tabs = KIND_TABS.map(([k, label]) => [k, ` ${label} `]);
    const tw = tabs.reduce((n, [, t]) => n + strWidth(t), 0) + 1;
    if (l.room > tw) {
      l.add('', '', l.room - tw);
      for (const [k, t] of tabs) l.add(t, k === this.kind ? S.tabOn : S.tabOff);
    }
    return l.done();
  }

  footer(cols) {
    const l = new Line(cols);
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
    for (const [k, label] of HINTS) {
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

  helpBody(cols, h) {
    const w = Math.min(cols - 2, 76);
    const keyW = 20;
    const content = HELP.map(([k, d]) => new Line(w - 2).add(' ').add(k, S.accent, keyW).add(d).done());
    content.push(' '.repeat(w - 2), new Line(w - 2).add(' Press any key to close.', S.dim).done());
    const boxH = Math.min(h, content.length + 2);
    const drawn = box(content, w, boxH, { title: 'Keys', focused: true });
    const left = Math.floor((cols - w) / 2);
    const top = Math.max(0, Math.floor((h - boxH) / 2));
    const lines = Array.from({ length: h }, () => ' '.repeat(cols));
    drawn.forEach((d, i) => {
      lines[top + i] = `${' '.repeat(left)}${d}${' '.repeat(cols - left - w)}`;
    });
    return lines;
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
      const [{ getXboxAuth }, { fetchAll }] = await Promise.all([import('../auth.js'), import('../mediahub.js')]);
      const xsts = await getXboxAuth();
      const all = await fetchAll(['screenshot', 'clip']);
      return { gamertag: xsts.gamertag, items: applyFilters(all, filters) };
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
  const browser = new Browser({
    write: (s) => stdout.write(s),
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    openUrl,
    outDir: resolve(values.out),
    hdr: !!values.hdr,
    jobs: Number(values.jobs) || 4,
    protocol,
    initial: { kind: kinds.length === 1 ? kinds[0] : 'all', game: values.game ?? '' },
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
