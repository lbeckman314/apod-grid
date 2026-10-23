#!/usr/bin/env node
// Build apod.json from NASA's APOD archive on science.nasa.gov (its WordPress JSON API).
//
//   node fetch-apod.mjs --last 10                      # the 10 most recent days
//   node fetch-apod.mjs --start 2024-01-01 --end 2024-01-31
//   node fetch-apod.mjs --update                       # add days newer than the file's latest
//   node fetch-apod.mjs                                # the whole archive (~11,500 days, a few minutes)
//
// Options:
//   --out FILE        output file (default: apod.json); existing entries are kept and merged
//
// No API key needed. Requires Node 18+ (built-in fetch). No dependencies.

import { readFile, writeFile, rename } from 'node:fs/promises';

const FIRST = '1995-06-16';
const SITE = (process.env.APOD_SITE_URL || 'https://science.nasa.gov').replace(/\/$/, '');
const POSTS = `${SITE}/wp-json/wp/v2/image-article`;
const MEDIA = `${SITE}/wp-json/wp/v2/media`;
const PER_PAGE = 100;       // the API's maximum
const PAUSE_MS = 1000;      // pause between requests, to go easy on NASA's site
const MAX_TRIES = 5;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

// --- arguments -------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);
if (flag('--help') || flag('-h')) {
  console.log((await readFile(new URL(import.meta.url), 'utf8')).split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const out = opt('--out') || 'apod.json';

// --- helpers ---------------------------------------------------------------
// APOD posts on US Eastern time.
const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–',
  mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#'
    ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : (NAMED[e.toLowerCase()] ?? m));

// The day comes from the page address, e.g. /image-article/apod-2026-october-22-the-first-green-star/.
// Posts without that pattern aren't APOD days and are skipped.
function dateFromLink(link) {
  const m = /\/apod-(\d{4})-([a-z]+)-(\d{1,2})(?:-|\/)/.exec(link || '');
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  return month < 0 ? null : `${m[1]}-${pad(month + 1)}-${pad(m[3])}`;
}

// "APOD: 2026 October 22 – The First Green Star" -> "The First Green Star"
const cleanTitle = (rendered) => decode((rendered || '').replace(/<[^>]*>/g, ''))
  .replace(/^APOD:\s*\d{4}\s+[A-Za-z]+\s+\d{1,2}\s*[–—-]\s*/, '').trim() || 'Untitled';

// A ~30 KB version for the grid. NASA's image service resizes on request (it ignores
// crop settings, so the grid crops tiles to squares itself).
function thumbFrom(url) {
  if (!url) return undefined;
  const params = 'w=480&h=480&fit=clip';
  if (url.includes('/dynamicimage/')) return url.split('?')[0] + '?' + params;
  const m = /^https:\/\/assets\.science\.nasa\.gov\/content\/dam\/(.+?\.(?:jpe?g|png|gif|webp))(?:\/jcr:content.*)?$/i.exec(url);
  return m ? `https://assets.science.nasa.gov/dynamicimage/assets/${m[1]}?${params}` : undefined;
}

async function getJSON(url) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'apod-grid fetch script' } });
    } catch (e) {
      if (attempt >= MAX_TRIES) throw new Error(`network error: ${e.message}`);
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (res.ok) {
      return {
        data: await res.json(),
        total: +res.headers.get('x-wp-total') || 0,
        totalPages: +res.headers.get('x-wp-totalpages') || 1,
      };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_TRIES) {
      const wait = (+res.headers.get('retry-after') || 2 ** attempt) * 1000;
      console.log(`  HTTP ${res.status}, retrying in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ''}`);
  }
}

// --- existing data -----------------------------------------------------------
let existing = [];
try {
  existing = JSON.parse(await readFile(out, 'utf8'));
  if (!Array.isArray(existing)) throw new Error('not an array');
} catch (e) {
  if (e.code !== 'ENOENT') { console.error(`Can't read ${out}: ${e.message}`); process.exit(1); }
}
// Entries without a "link" came from the old api.nasa.gov version of this script; drop them.
const byDate = new Map(existing.filter((e) => e.link).map((e) => [e.date, e]));
const dropped = existing.length - byDate.size;
if (dropped) console.log(`Removed ${dropped} old-format entries from ${out}.`);

// --- range -----------------------------------------------------------------
const today = todayET();
let start, end = opt('--end') || today;
if (flag('--update')) {
  const latest = [...byDate.keys()].reduce((m, d) => (d > m ? d : m), '');
  start = latest ? addDays(latest, 1) : FIRST;
} else if (opt('--last')) {
  const n = parseInt(opt('--last'), 10);
  if (!(n > 0)) { console.error('--last needs a positive number of days'); process.exit(1); }
  start = addDays(end, -(n - 1));
} else {
  start = opt('--start') || FIRST;
}
for (const [name, v] of [['--start', start], ['--end', end]]) {
  if (!isDate(v)) { console.error(`${name} must look like YYYY-MM-DD (got "${v}")`); process.exit(1); }
}
if (start < FIRST) start = FIRST;
if (end > today) end = today;
if (start > end) { console.log(`Nothing to fetch: ${out} is already up to date.`); process.exit(0); }
const wholeArchive = start === FIRST && end === today;

// --- 1. posts ------------------------------------------------------------------
console.log(`Fetching ${start} to ${end} from ${SITE} into ${out}`);
let failed = false;
const posts = [];
try {
  for (let page = 1, totalPages = 1; page <= totalPages; page++) {
    const q = new URLSearchParams({
      search: 'apod', orderby: 'date', order: 'desc', per_page: PER_PAGE, page,
      _fields: 'id,date,link,title,featured_media',
    });
    if (!wholeArchive) {
      q.set('after', `${addDays(start, -1)}T23:59:59`);
      q.set('before', `${end}T23:59:59`);
    }
    if (page > 1) await sleep(PAUSE_MS);
    const r = await getJSON(`${POSTS}?${q}`);
    totalPages = r.totalPages;
    posts.push(...r.data);
    console.log(`  posts page ${page}/${totalPages}: ${r.data.length}${page === 1 ? ` (${r.total} total)` : ''}`);
  }
} catch (e) {
  console.error(`  Stopped reading posts: ${e.message}`);
  failed = true;
}

const fresh = [];
for (const p of posts) {
  const date = dateFromLink(p.link);
  if (!date || date < start || date > end) continue;
  fresh.push({ id: p.id, date, title: cleanTitle(p.title?.rendered), link: p.link, media: p.featured_media || 0 });
}

// --- 2. images -------------------------------------------------------------------
const ids = [...new Set(fresh.map((e) => e.media).filter(Boolean))];
const media = new Map();
for (let i = 0; i < ids.length; i += PER_PAGE) {
  const chunk = ids.slice(i, i + PER_PAGE);
  const q = new URLSearchParams({ include: chunk.join(','), per_page: PER_PAGE, _fields: 'id,source_url,mime_type,media_details' });
  try {
    await sleep(PAUSE_MS);
    const r = await getJSON(`${MEDIA}?${q}`);
    for (const m of r.data) media.set(m.id, m);
    console.log(`  images ${Math.min(i + PER_PAGE, ids.length)}/${ids.length}`);
  } catch (e) {
    console.error(`  Couldn't read images ${i + 1}-${i + chunk.length}: ${e.message}`);
    failed = true;
  }
}

// --- 3. images from the article text ------------------------------------------------
// Older posts (1995-1998) have a generic NASA picture as their featured image, and a few
// have none. Their real image, or a YouTube video, is in the article text instead.
const isApodImage = (url) => /\/cds\/apod\//.test(url || '');
const need = fresh.filter((f) => !isApodImage(media.get(f.media)?.source_url));
const fromContent = new Map();
const CONTENT_CHUNK = 25; // article text is bulky, so fewer per request
for (let i = 0; i < need.length; i += CONTENT_CHUNK) {
  const chunk = need.slice(i, i + CONTENT_CHUNK);
  const q = new URLSearchParams({ include: chunk.map((f) => f.id).join(','), per_page: CONTENT_CHUNK, _fields: 'id,content' });
  try {
    await sleep(PAUSE_MS);
    const r = await getJSON(`${POSTS}?${q}`);
    for (const p of r.data) {
      const html = p.content?.rendered || '';
      const img = /\ssrc="(https:\/\/assets\.science\.nasa\.gov\/[^"]*\/cds\/apod\/[^"]+\.(?:jpe?g|png|gif|webp))"/i.exec(html);
      const yt = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/.exec(html);
      if (img) fromContent.set(p.id, { image: decode(img[1]) });
      else if (yt) fromContent.set(p.id, { image: `https://img.youtube.com/vi/${yt[1]}/hqdefault.jpg`, video: true });
    }
    console.log(`  article images ${Math.min(i + CONTENT_CHUNK, need.length)}/${need.length}`);
  } catch (e) {
    console.error(`  Couldn't read article text ${i + 1}-${i + chunk.length}: ${e.message}`);
    failed = true;
  }
}

// --- 4. merge and save -----------------------------------------------------------
let added = 0, updated = 0, noImage = 0;
for (const f of fresh) {
  const m = media.get(f.media);
  const c = fromContent.get(f.id);
  const e = { date: f.date, title: f.title, link: f.link };
  if (c) {
    e.image = c.image;
    const thumb = thumbFrom(c.image);
    if (thumb) e.thumb = thumb;
    if (c.video) e.media_type = 'video';
  } else if (isApodImage(m?.source_url)) {
    e.image = m.source_url;
    // Prefer NASA's resizer; WordPress's own "small" sizes for APOD are 768-1280px.
    const sizes = m.media_details?.sizes || {};
    const small = sizes.medium || sizes.medium_large;
    const thumb = thumbFrom(m.source_url) || small?.source_url;
    if (thumb && thumb !== e.image) e.thumb = thumb;
    if (/^video\//.test(m.mime_type || '')) e.media_type = 'video';
  } else {
    noImage++;
  }
  byDate.has(e.date) ? updated++ : added++;
  byDate.set(e.date, e);
}

const entries = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
// One entry per line keeps the file readable and its git diffs small.
const json = '[\n' + entries.map((e) => JSON.stringify(e)).join(',\n') + '\n]\n';
await writeFile(out + '.tmp', json);
await rename(out + '.tmp', out);
console.log(`Saved ${entries.length} entries to ${out} (${added} new, ${updated} refreshed` +
  `${noImage ? `, ${noImage} without an image` : ''}).`);
if (failed) console.error('Some requests failed. Run the same command again to fill in what was missed.');
process.exit(failed ? 1 : 0);

