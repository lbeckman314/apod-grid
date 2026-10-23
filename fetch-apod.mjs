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
//   --text-out FILE   each day's explanation, for the search index (default: apod-text.json)
//
// No API key needed. Requires Node 18+ (built-in fetch). No dependencies.

import { readFile, writeFile, rename } from 'node:fs/promises';

const FIRST = '1995-06-16';
const SITE = (process.env.APOD_SITE_URL || 'https://science.nasa.gov').replace(/\/$/, '');
const POSTS = `${SITE}/wp-json/wp/v2/image-article`;
const PER_PAGE = 100;       // the API's maximum
const PAUSE_MS = 1000;      // pause between requests, to go easy on NASA's site
const MAX_TRIES = 5;

// --- arguments -------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);
if (flag('--help') || flag('-h')) {
  console.log((await readFile(new URL(import.meta.url), 'utf8')).split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const out = opt('--out') || 'apod.json';
const textOut = opt('--text-out') || 'apod-text.json';

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

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–',
  mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#'
    ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : (NAMED[e.toLowerCase()] ?? m));

// APOD posts are titled "APOD: 2026 October 22 – …". The day comes from the post's publish
// date (US Eastern), not its address: a few addresses have the wrong day or none at all.
const isApodPost = (p) => /^\s*APOD\b/i.test(decode(p.title?.rendered || ''));
const postDate = (p) => (isDate((p.date || '').slice(0, 10)) ? p.date.slice(0, 10) : null);

// "APOD: 2026 October 22 – The First Green Star" -> "The First Green Star" (also "APOD: 2026 April – …")
const cleanTitle = (rendered) => decode((rendered || '').replace(/<[^>]*>/g, ''))
  .replace(/^APOD:\s*[\w,.\s]*?\d[\w,.\s]*?\s*[–—-]\s*/, '').trim() || 'Untitled';

// A ~30 KB version for the grid. NASA's image service resizes on request (it ignores
// crop settings, so the grid crops tiles to squares itself).
function thumbFrom(url) {
  if (!url) return undefined;
  const params = 'w=480&h=480&fit=clip';
  if (/\.gif(\?|$)/i.test(url)) return undefined; // the resizer can't do GIFs; they're small anyway
  if (url.includes('/dynamicimage/')) return url.split('?')[0] + '?' + params;
  const m = /^https:\/\/assets\.science\.nasa\.gov\/content\/dam\/(.+?\.(?:jpe?g|png|webp))(?:\/jcr:content.*)?$/i.exec(url);
  return m ? `https://assets.science.nasa.gov/dynamicimage/assets/${m[1]}?${params}` : undefined;
}

async function getJSON(url) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'apod-grid (+https://github.com/lbeckman314/apod-grid)' } });
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

// Explanations live in their own file, keyed by date, so the grid never has to load them.
let texts = {};
try {
  texts = JSON.parse(await readFile(textOut, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') { console.error(`Can't read ${textOut}: ${e.message}`); process.exit(1); }
}

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
      _fields: 'date,link,title,featured_image_url,content',
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

// --- 2. images and media type ---------------------------------------------------------
// NASA's data has no media-type field, so it comes from what the article embeds.
// Only embeds count, not ordinary links: articles link to plenty of unrelated pages.
const isApodImage = (url) => /\/cds\/apod\//.test(url || '');
// Block-level breaks become spaces; inline tags vanish, so "<a>Sun</a>," stays "Sun,".
const toText = (html) => decode(html.replace(/<(?:br|\/p|\/div|\/li|\/td)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, ''))
  .replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/\(\s+/g, '(').trim();

// The article's details table has a row like <th>Credit</th><td>Credit &amp; Copyright: Steve Mandel</td>
// (newer posts label it "Credit &amp; Copyright").
// "Copyright" or "License" in the label or the prefix means the image isn't public domain.
function creditIn(html) {
  const m = /<th\b[^>]*>([^<]*(?:Credit|Copyright)[^<]*)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(html);
  if (!m) return {};
  // Lines are split by <br>; a "Text: …" line names the explanation's writer, not the image's.
  const text = m[2].split(/<br\b[^>]*>/i).map((l) => toText(l).replace(/(?:^|\s+)Text\s*:.*$/i, '').replace(/[;,\s]+$/, ''))
    .filter(Boolean).join('; ');
  const prefix = /^(?:[a-z]+\s+){0,3}(?:Credits?(?:\s*(?:&|and)\s*(?:Copyright|License))?|Copyright)\s*:\s*/i.exec(text)?.[0] || '';
  return { credit: text.slice(prefix.length).trim(), copyright: /copyright|license/i.test(m[1] + prefix) };
}

// The main image's description, from the first APOD image in the article that has one.
function altIn(html) {
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\ssrc="[^"]*\/cds\/apod\//i.test(tag)) continue;
    const alt = /\salt="([^"]*)"/i.exec(tag)?.[1];
    // Old posts all say "See Explanation. Clicking on the picture will download…".
    if (alt && alt.trim() && !/^\s*See Explanation\b/i.test(alt)) return toText(alt);
  }
  return '';
}

// <p class="... media-detail-hero__description"><strong>Explanation:</strong> ... Tomorrow's picture: ...</p>
function explanationIn(html) {
  const m = /<p\b[^>]*media-detail-hero__description[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  return m ? toText(m[1]).replace(/^Explanation:\s*/i, '').replace(/\s*Tomorrow['’]s picture:.*$/i, '').trim() : '';
}

function embedIn(html) {
  const attr = (tag) => new RegExp(`<${tag}\\b[^>]*?\\s(?:src|data)="([^"]+)"`, 'i').exec(html)?.[1];
  const frame = attr('iframe');
  if (frame) {
    const yt = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/.exec(frame);
    if (yt) return { media_type: 'video', embed: `https://www.youtube.com/watch?v=${yt[1]}`, poster: `https://img.youtube.com/vi/${yt[1]}/hqdefault.jpg` };
    if (/vimeo\.com\//.test(frame)) return { media_type: 'video', embed: frame };
    return { media_type: 'interactive', embed: frame };
  }
  const video = attr('video') || (/<video\b/i.test(html) && attr('source'));
  if (video || /<video\b/i.test(html)) return { media_type: 'video', embed: video || undefined };
  const audio = attr('audio') || (/<audio\b/i.test(html) && attr('source'));
  if (audio || /<audio\b/i.test(html)) return { media_type: 'audio', embed: audio || undefined };
  const obj = attr('object') || attr('embed');
  if (obj) return { media_type: 'interactive', embed: obj };
  return null;
}

let added = 0, updated = 0, noImage = 0, noCredit = 0, noText = 0;
const counts = {};
const seen = new Set();
for (const p of posts) {
  if (!isApodPost(p)) continue;
  const date = postDate(p);
  if (!date || date < start || date > end) continue;
  const html = p.content?.rendered || '';
  const e = { date, title: cleanTitle(p.title?.rendered), link: p.link };
  const { credit, copyright } = creditIn(html);
  if (credit) e.credit = credit; else noCredit++;
  if (copyright) e.copyright = true;
  const alt = altIn(html);
  if (alt) e.alt = alt;
  const text = explanationIn(html);
  if (text) texts[date] = text; else noText++;

  // Older posts (1995-1998) have a generic NASA picture as their featured image;
  // their real one is in the article text.
  let image = (p.featured_image_url || '').split('?')[0] || undefined;
  if (!isApodImage(image)) {
    const m = /\ssrc="(https:\/\/assets\.science\.nasa\.gov\/[^"]*\/cds\/apod\/[^"]+\.(?:jpe?g|png|gif|webp))"/i.exec(html);
    image = m ? decode(m[1]) : undefined;
  }
  const media = embedIn(html);
  if (!image && media?.poster) image = media.poster;
  if (image) {
    e.image = image;
    const thumb = thumbFrom(image);
    if (thumb && thumb !== image) e.thumb = thumb;
  } else {
    noImage++;
  }
  if (media) {
    e.media_type = media.media_type;
    if (media.embed) e.embed = decode(media.embed).replace(/^\/\//, 'https://');
  }
  counts[e.media_type || 'image'] = (counts[e.media_type || 'image'] || 0) + 1;
  if (seen.has(date)) console.warn(`  Two posts for ${date}; keeping ${p.link}`);
  seen.add(date);
  byDate.has(e.date) ? updated++ : added++;
  byDate.set(e.date, e);
}

const entries = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
// One entry per line keeps the file readable and its git diffs small.
const json = '[\n' + entries.map((e) => JSON.stringify(e)).join(',\n') + '\n]\n';
await writeFile(out + '.tmp', json);
await rename(out + '.tmp', out);
const textJson = '{\n' + Object.keys(texts).sort().reverse()
  .map((d) => `${JSON.stringify(d)}:${JSON.stringify(texts[d])}`).join(',\n') + '\n}\n';
await writeFile(textOut + '.tmp', textJson);
await rename(textOut + '.tmp', textOut);
console.log(`Saved ${entries.length} entries to ${out} (${added} new, ${updated} refreshed` +
  `${noImage ? `, ${noImage} without an image` : ''}${noCredit ? `, ${noCredit} without a credit` : ''}` +
  `${noText ? `, ${noText} without an explanation` : ''}).`);
if (added + updated) console.log('  This run: ' + Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', '));
if (failed) console.error('Some requests failed. Run the same command again to fill in what was missed.');
process.exit(failed ? 1 : 0);
