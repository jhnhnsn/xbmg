const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parses a date option. Accepts "7d" (relative days), "YYYY-MM-DD" (local
 * day), or any ISO timestamp. With endOfDay, a plain date means the end of
 * that day, so "--until 2026-11-01" includes all of 1 November.
 */
export function parseDate(text, { endOfDay = false, now = Date.now() } = {}) {
  if (text == null) return undefined;
  const rel = /^(\d+)d$/.exec(text);
  if (rel) return now - Number(rel[1]) * DAY_MS;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const start = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
    return endOfDay ? start + DAY_MS : start;
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`Invalid date "${text}". Use YYYY-MM-DD, an ISO time, or a number of days like 7d.`);
  return ms;
}

/** Parses --type into the list of kinds to fetch. */
export function parseKinds(text = 'all') {
  const t = text.toLowerCase();
  if (['all', 'both'].includes(t)) return ['screenshot', 'clip'];
  if (['screenshot', 'screenshots', 'shot', 'shots'].includes(t)) return ['screenshot'];
  if (['clip', 'clips', 'gameclip', 'gameclips', 'video', 'videos'].includes(t)) return ['clip'];
  throw new Error(`Invalid --type "${text}". Use shots, clips or all.`);
}

function time(item) {
  const ms = Date.parse(item.date);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Filters and sorts captures, newest first. */
export function applyFilters(items, { game, since, until, ids, limit } = {}) {
  let out = items;
  if (game) {
    const g = game.toLowerCase();
    out = out.filter((i) => i.game.toLowerCase().includes(g));
  }
  if (since !== undefined) out = out.filter((i) => time(i) >= since);
  if (until !== undefined) out = out.filter((i) => time(i) < until);
  if (ids?.length) {
    const prefixes = ids.map((id) => id.toLowerCase());
    out = out.filter((i) => prefixes.some((p) => i.id?.toLowerCase().startsWith(p)));
  }
  out = [...out].sort((a, b) => time(b) - time(a));
  if (limit) out = out.slice(0, limit);
  return out;
}

/** Groups captures by game for the "games" command. */
export function summarizeGames(items) {
  const games = new Map();
  for (const i of items) {
    const g = games.get(i.game) ?? { game: i.game, screenshots: 0, clips: 0, latest: null };
    if (i.kind === 'screenshot') g.screenshots++;
    else g.clips++;
    if (i.date && (!g.latest || Date.parse(i.date) > Date.parse(g.latest))) g.latest = i.date;
    games.set(i.game, g);
  }
  return [...games.values()].sort((a, b) => (Date.parse(b.latest) || 0) - (Date.parse(a.latest) || 0));
}
