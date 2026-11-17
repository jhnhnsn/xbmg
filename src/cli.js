import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AuthError, DEFAULT_CLIENT_ID, authHint, browserLogin, deviceCodeLogin, getXboxAuth, preferDeviceCode } from './auth.js';
import { downloadOne, runPool, source, targetPath } from './download.js';
import { applyFilters, parseDate, parseKinds, summarizeGames } from './filters.js';
import { formatBytes } from './format.js';
import { fetchAll } from './mediahub.js';
import { clearSession, loadSession, saveSession, sessionPath } from './session.js';

const HELP = `xbmg - browse and download your Xbox screenshots and game clips

Usage:
  xbmg                              Open the browser (when run in a terminal)
  xbmg browse [filters] [--demo]    Browse captures with previews, select, download
  xbmg login [--client-id <id>]     Sign in with your Microsoft account in the browser
             [--device-code]        Sign in with a code instead (for example over SSH)
  xbmg whoami                       Show the signed-in gamertag
  xbmg logout                       Delete the saved sign-in
  xbmg games                        List games with capture counts
  xbmg list [filters]               List captures, newest first
  xbmg open <id>                    Open a capture in your browser
  xbmg download [ids...] [filters]  Download captures

Filters (list, games, download):
  -t, --type <shots|clips|all>      Kind of capture (default: all)
  -g, --game <text>                 Game name contains this text
      --since <date>                On or after: YYYY-MM-DD, ISO time, or 7d
      --until <date>                On or before (YYYY-MM-DD includes that day)
  -n, --limit <n>                   Only the newest n captures
      --json                        Print JSON instead of a table

Download options:
  -o, --out <dir>                   Output folder (default: ./xbox-captures)
      --hdr                         Get the HDR original when there is one
  -j, --jobs <n>                    Parallel downloads (default: 4)
      --dry-run                     Show what would download, then stop

Other:
      --demo                        browse: use made-up captures, no sign-in
      --debug                       Print raw API responses and stack traces
  -h, --help                        Show this help

The client ID comes from --client-id, then XBMG_CLIENT_ID, then the saved
sign-in. See README.md for how to create one.`;

const OPTIONS = {
  type: { type: 'string', short: 't', default: 'all' },
  game: { type: 'string', short: 'g' },
  since: { type: 'string' },
  until: { type: 'string' },
  limit: { type: 'string', short: 'n' },
  json: { type: 'boolean' },
  out: { type: 'string', short: 'o', default: 'xbox-captures' },
  hdr: { type: 'boolean' },
  jobs: { type: 'string', short: 'j', default: '4' },
  'dry-run': { type: 'boolean' },
  'client-id': { type: 'string' },
  'device-code': { type: 'boolean' },
  demo: { type: 'boolean' },
  debug: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const out = (line = '') => process.stdout.write(`${line}\n`);
const err = (line = '') => process.stderr.write(`${line}\n`);

function formatDuration(s) {
  if (!s) return '';
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  out(line(headers));
  for (const r of rows) out(line(r));
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parsePositiveInt(text, name) {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of 1 or more.`);
  return n;
}

function buildFilters(values, ids) {
  return {
    game: values.game,
    since: parseDate(values.since),
    until: parseDate(values.until, { endOfDay: true }),
    limit: parsePositiveInt(values.limit, '--limit'),
    ids,
  };
}

async function loadCaptures(values, ids = []) {
  const kinds = parseKinds(values.type);
  const filters = buildFilters(values, ids);
  const debug = values.debug ? (label, body) => err(`[debug] ${label}\n${JSON.stringify(body, null, 2)}`) : undefined;
  if (process.stderr.isTTY && !values.json) err('Fetching captures from Xbox…');
  const all = await fetchAll(kinds, { debug });
  return applyFilters(all, filters);
}

async function cmdLogin(values) {
  const existing = await loadSession();
  const clientId = values['client-id'] || process.env.XBMG_CLIENT_ID || existing?.clientId || DEFAULT_CLIENT_ID;
  if (!clientId) {
    throw new Error('A client ID is necessary. Use "xbmg login --client-id <id>". See README.md for setup.');
  }
  let ms;
  try {
    ms =
      values['device-code'] || preferDeviceCode()
        ? await deviceCodeLogin(clientId, (message) => out(`\n${message}\n`))
        : await browserLogin(clientId, {
            onUrl: async (url) => {
              out('Opening the Microsoft sign-in page in your web browser…');
              out(`If it does not open, open this link:\n\n  ${url}\n`);
              out('If the browser shows an error, press Ctrl-C and run "xbmg login --device-code".');
              await openInBrowser(url).catch(() => {});
            },
          });
  } catch (e) {
    const hint = authHint(e.message);
    if (hint) e.message = `${e.message}\n${hint}`;
    throw e;
  }
  await saveSession({ clientId, ms });
  const xsts = await getXboxAuth({ force: true });
  out(`Signed in as ${xsts.gamertag ?? 'unknown gamertag'} (XUID ${xsts.xuid}).`);
  out(`Saved sign-in to ${sessionPath()}`);
}

async function cmdWhoami() {
  const xsts = await getXboxAuth();
  out(`${xsts.gamertag ?? 'unknown gamertag'} (XUID ${xsts.xuid})`);
}

async function cmdLogout() {
  await clearSession();
  out('Signed out. The saved sign-in is deleted.');
}

async function cmdGames(values) {
  const games = summarizeGames(await loadCaptures(values));
  if (values.json) return out(JSON.stringify(games, null, 2));
  if (!games.length) return out('No captures found.');
  table(
    games.map((g) => [truncate(g.game, 40), g.screenshots, g.clips, formatDate(g.latest)]),
    ['GAME', 'SHOTS', 'CLIPS', 'LATEST'],
  );
}

async function cmdList(values) {
  const items = await loadCaptures(values);
  if (values.json) return out(JSON.stringify(items, null, 2));
  if (!items.length) return out('No captures found.');
  table(
    items.map((i) => [
      String(i.id).slice(0, 8),
      i.kind === 'clip' ? 'clip' : 'shot',
      formatDate(i.date),
      truncate(i.game, 32),
      i.width && i.height ? `${i.width}x${i.height}` : '',
      i.kind === 'clip' ? formatDuration(i.duration) : i.hdrUrl ? 'HDR' : '',
      formatBytes(i.size),
    ]),
    ['ID', 'TYPE', 'DATE', 'GAME', 'RES', 'LEN/HDR', 'SIZE'],
  );
  const shots = items.filter((i) => i.kind === 'screenshot').length;
  out(`\n${items.length} captures (${shots} screenshots, ${items.length - shots} clips).`);
}

export function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  return new Promise((done, fail) => execFile(cmd, args, (e) => (e ? fail(e) : done())));
}

async function cmdOpen(values, ids) {
  if (ids.length !== 1) throw new Error('Give one capture ID. Use "xbmg list" to see IDs.');
  const matches = await loadCaptures({ ...values, limit: undefined }, ids);
  if (!matches.length) throw new Error(`No capture has an ID that starts with "${ids[0]}".`);
  if (matches.length > 1) throw new Error(`"${ids[0]}" matches ${matches.length} captures. Give more characters.`);
  const { url } = source(matches[0], { hdr: values.hdr });
  await openInBrowser(url);
  out(`Opened ${matches[0].game} ${matches[0].kind} from ${formatDate(matches[0].date)}.`);
}

async function cmdDownload(values, ids) {
  const items = await loadCaptures(values, ids);
  if (!items.length) return out('No captures match.');
  const outDir = resolve(values.out);
  const jobs = parsePositiveInt(values.jobs, '--jobs');
  const total = items.reduce((sum, i) => sum + (source(i, values).size || 0), 0);
  out(`${items.length} captures, about ${formatBytes(total)}, to ${outDir}`);

  if (values['dry-run']) {
    for (const i of items) out(`  ${targetPath(outDir, i, values)}`);
    return;
  }

  let done = 0;
  let downloaded = 0;
  let skipped = 0;
  const failed = [];
  await runPool(items, jobs, async (item) => {
    const dest = targetPath(outDir, item, values);
    const rel = dest.slice(outDir.length + 1);
    try {
      const r = await downloadOne(item, dest, values);
      done++;
      if (r.status === 'skipped') {
        skipped++;
        out(`[${done}/${items.length}] exists   ${rel}`);
      } else {
        downloaded++;
        out(`[${done}/${items.length}] saved    ${rel} (${formatBytes(r.bytes)})`);
      }
    } catch (e) {
      done++;
      failed.push(item);
      err(`[${done}/${items.length}] FAILED   ${rel}: ${e.message}`);
    }
  });
  out(`\nDone: ${downloaded} downloaded, ${skipped} already there, ${failed.length} failed.`);
  if (failed.length) {
    err('Run the same command again to retry the failed items.');
    return 1;
  }
}

async function cmdBrowse(values) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('"xbmg browse" needs an interactive terminal.');
  const { runBrowser } = await import('./tui/app.js');
  return runBrowser(values, { openUrl: openInBrowser });
}

const COMMANDS = {
  browse: cmdBrowse,
  ui: cmdBrowse,
  login: cmdLogin,
  whoami: cmdWhoami,
  logout: cmdLogout,
  games: cmdGames,
  list: cmdList,
  ls: cmdList,
  open: cmdOpen,
  download: cmdDownload,
  dl: cmdDownload,
};

export async function main(argv) {
  let values = {};
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    values = parsed.values;
    let [command, ...ids] = parsed.positionals;
    if (!command && !values.help && process.stdin.isTTY && process.stdout.isTTY) command = 'browse';
    if (values.help || !command || command === 'help') {
      out(HELP);
      return 0;
    }
    const run = COMMANDS[command];
    if (!run) throw new Error(`Unknown command "${command}". Run "xbmg --help".`);
    return (await run(values, ids)) ?? 0;
  } catch (e) {
    err(e instanceof AuthError ? e.message : `Error: ${e.message}`);
    if (values.debug && e.stack) err(e.stack);
    return 1;
  }
}
