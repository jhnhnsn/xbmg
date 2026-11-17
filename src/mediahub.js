import { setTimeout as sleep } from 'node:timers/promises';
import { authHeader, getXboxAuth } from './auth.js';

const BASE = 'https://mediahub.xboxlive.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;

const PATHS = { screenshot: 'screenshots', clip: 'gameclips' };

function findLocator(v, type) {
  return v.contentLocators?.find((l) => l.locatorType === type);
}

/** Turns a raw MediaHub record into the flat shape the rest of the tool uses. */
export function normalize(kind, v) {
  const download = findLocator(v, 'Download');
  const hdr = findLocator(v, 'Download_HDR');
  const thumb = findLocator(v, 'Thumbnail_Large') || findLocator(v, 'Thumbnail_Small');
  return {
    kind,
    id: v.contentId,
    game: v.titleName || 'Unknown game',
    titleId: v.titleId,
    date: v.captureDate || v.dateRecorded || v.uploadDate || null,
    width: v.resolutionWidth,
    height: v.resolutionHeight,
    duration: v.durationInSeconds,
    caption: v.userCaption || '',
    url: download?.uri,
    size: download?.fileSize,
    hdrUrl: hdr?.uri,
    hdrSize: hdr?.fileSize,
    thumbUrl: thumb?.uri,
  };
}

async function searchPage(path, auth, skip) {
  return fetch(`${BASE}/${path}/search`, {
    method: 'POST',
    headers: {
      authorization: authHeader(auth),
      'x-xbl-contract-version': '3',
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-language': 'en-US',
    },
    body: JSON.stringify({ max: PAGE_SIZE, skip, query: `OwnerXuid eq ${auth.xuid}` }),
  });
}

/** Fetches every capture of one kind ("screenshot" or "clip") for the signed-in user. */
export async function fetchCaptures(kind, { getAuth = getXboxAuth, debug } = {}) {
  const path = PATHS[kind];
  let auth = await getAuth();
  let reauthed = false;
  let throttled = 0;
  const items = [];
  let skip = 0;

  for (let page = 0; page < MAX_PAGES; ) {
    const res = await searchPage(path, auth, skip);

    if (res.status === 401 && !reauthed) {
      auth = await getAuth({ force: true });
      reauthed = true;
      continue;
    }
    if (res.status === 429 && throttled < 5) {
      throttled++;
      const wait = Number(res.headers.get('retry-after')) || 2 ** throttled;
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`Xbox MediaHub ${path} request failed: HTTP ${res.status} ${detail}`);
    }

    const body = await res.json();
    if (debug) debug(`${path} skip=${skip}`, body);
    const values = body.values ?? [];
    for (const v of values) items.push(normalize(kind, v));
    if (values.length < PAGE_SIZE) break;
    skip += values.length;
    page++;
  }
  return items;
}

/** kinds: array of "screenshot" | "clip". */
export async function fetchAll(kinds, opts) {
  const lists = await Promise.all(kinds.map((k) => fetchCaptures(k, opts)));
  return lists.flat();
}
