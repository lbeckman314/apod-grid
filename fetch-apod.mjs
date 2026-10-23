#!/usr/bin/env node
// Build apod.json from NASA's APOD archive on science.nasa.gov (its WordPress JSON API).
//
//   node fetch-apod.mjs --last 10                      # the 10 most recent days
//   node fetch-apod.mjs --start 2024-01-01 --end 2024-01-31
//   node fetch-apod.mjs --update                       # add new days, and refresh days NASA has edited
//   node fetch-apod.mjs                                # the whole archive (~11,500 days, a few minutes)
//
// Options:
//   --out FILE        output file (default: apod.json); existing entries are kept and merged
//   --details-dir DIR   everything else about each day, one file per year (default: apod-details)
//
// apod.json holds what the grid needs and stays small, since the grid loads all of it.
// apod-details/YYYY.json holds the rest: explanation text and HTML, credit HTML, editors,
// full-resolution links, every image's size, and NASA's post IDs.
//
// No API key needed. Requires Node 18+ (built-in fetch). No dependencies.

import { readFile, writeFile, rename, readdir, mkdir } from 'node:fs/promises';

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
  console.log((await readFile(new URL(import.meta.url), 'utf8')).split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const out = opt('--out') || 'apod.json';
const detailsDir = opt('--details-dir') || 'apod-details';

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

// Details live in their own files, one per year and keyed by date, so the grid never has to
// load them and a daily update only rewrites the current year's file.
const details = {};
const touchedYears = new Set();
try {
  for (const f of (await readdir(detailsDir)).filter((f) => /^\d{4}\.json$/.test(f))) {
    Object.assign(details, JSON.parse(await readFile(`${detailsDir}/${f}`, 'utf8')));
  }
} catch (e) {
  if (e.code !== 'ENOENT') { console.error(`Can't read ${detailsDir}/: ${e.message}`); process.exit(1); }
}

// --- range -----------------------------------------------------------------
const today = todayET();
let start, end = opt('--end') || today;
const update = flag('--update');
// The newest edit time we've saved; --update also refetches any post edited after it.
const lastModified = [...byDate.values()].reduce((m, e) => (e.modified > m ? e.modified : m), '');
if (update) {
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
const newDays = start <= end;
if (!newDays && !(update && lastModified)) { console.log(`Nothing to fetch: ${out} is already up to date.`); process.exit(0); }
const wholeArchive = start === FIRST && end === today;

// --- 1. posts ------------------------------------------------------------------
const FIELDS = 'id,slug,date,date_gmt,modified,modified_gmt,link,title,content,author,coauthors,categories,featured_media,featured_image_url';
let failed = false;
let requests = 0;

async function fetchPosts(label, params) {
  const found = [];
  try {
    for (let page = 1, totalPages = 1; page <= totalPages; page++) {
      const q = new URLSearchParams({ search: 'apod', orderby: 'date', order: 'desc', per_page: PER_PAGE, page, _fields: FIELDS, ...params });
      if (requests++) await sleep(PAUSE_MS);
      const r = await getJSON(`${POSTS}?${q}`);
      totalPages = r.totalPages;
      found.push(...r.data);
      console.log(`  ${label} page ${page}/${totalPages}: ${r.data.length}${page === 1 ? ` (${r.total} total)` : ''}`);
    }
  } catch (e) {
    console.error(`  Stopped reading ${label}: ${e.message}`);
    failed = true;
  }
  return found;
}

const posts = [];
if (newDays) {
  console.log(`Fetching ${start} to ${end} from ${SITE} into ${out}`);
  posts.push(...await fetchPosts('posts', wholeArchive ? {} : { after: `${addDays(start, -1)}T23:59:59`, before: `${end}T23:59:59` }));
}
// Posts NASA edited since our newest saved edit, on any day.
const edited = new Set();
if (update && lastModified) {
  console.log(`Checking for posts edited after ${lastModified}`);
  for (const p of await fetchPosts('edited posts', { modified_after: lastModified })) {
    if (posts.some((q) => q.id === p.id)) continue;
    edited.add(p.id);
    posts.push(p);
  }
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

// <p class="... media-detail-hero__description"><strong>Explanation:</strong> …
// <br><br><strong>Tomorrow's picture:</strong> space bees</p>
// Returns the explanation as HTML (NASA's, unsanitized) and as text, plus the teaser.
function explanationIn(html) {
  const m = /<p\b[^>]*media-detail-hero__description[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (!m) return {};
  let body = m[1].trim().replace(/^<strong>\s*Explanation:?\s*<\/strong>\s*/i, '');
  // Some migrated posts end with the old site's footer: "< | Archive | Submissions | … | >".
  const footer = /<a\b[^>]*>\s*&lt;\s*<\/a>\s*\|/i.exec(body);
  if (footer) body = body.slice(0, footer.index);
  let tomorrow = '';
  // Written several ways: "Tomorrow's picture:", "Tomorrow's APOD:", "Tomorrow:", bold or not.
  const t = /(?:<br\b[^>]*>\s*)*(?:<(?:strong|b|em|i)>\s*)*Tomorrow(?:(?:&#8217;|&#039;|&rsquo;|['’])s\s+(?:picture|APOD|image))?\s*:\s*(?:<\/(?:strong|b|em|i)>\s*)*([\s\S]*)$/i.exec(body);
  if (t) { tomorrow = toText(t[1]); body = body.slice(0, t.index); }
  body = body.replace(/(?:\s*<br\b[^>]*>)+\s*$/i, '').trim();
  return { html: body, text: toText(body).replace(/^Explanation:\s*/i, ''), tomorrow };
}

// The value cell of a details-table row, e.g. <th>Authors &amp; editors:</th><td>…</td>.
const rowIn = (html, label) => new RegExp(`<th\\b[^>]*>\\s*${label}[^<]*<\\/th>\\s*<td\\b[^>]*>([\\s\\S]*?)<\\/td>`, 'i').exec(html)?.[1].trim();

// Every APOD image in the article with its size, and the full-resolution link if the
// picture links to one (older posts do; newer ones use the original as the image itself).
const bare = (url) => decode(url).split('?')[0];
const apodPath = (url) => /\/cds\/apod\/(.+)$/.exec(bare(url || ''))?.[1].replace(/\/jcr:content.*$/, '');
function imagesIn(html) {
  const images = [];
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\ssrc="([^"]+)"/i.exec(tag)?.[1];
    if (!src || !/\/cds\/apod\//.test(src)) continue;
    const url = bare(src);
    if (images.some((i) => i.url === url)) continue;
    const w = +(/\swidth="(\d+)"/i.exec(tag)?.[1] || 0), h = +(/\sheight="(\d+)"/i.exec(tag)?.[1] || 0);
    images.push({ url, ...(w && h ? { width: w, height: h } : {}) });
  }
  const linked = /<a\b[^>]*\shref="([^"]+\/cds\/apod\/[^"]+)"[^>]*>\s*<img\b/i.exec(html)?.[1];
  const largest = images.filter((i) => i.width).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return { images, hdurl: linked ? bare(linked) : largest?.url };
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
  if (!date) continue;
  if (!edited.has(p.id) && (date < start || date > end)) continue;
  const html = p.content?.rendered || '';

  const e = { date, title: cleanTitle(p.title?.rendered), link: p.link, id: p.id, modified: p.modified };
  const { credit, copyright } = creditIn(html);
  if (credit) e.credit = credit; else noCredit++;
  if (copyright) e.copyright = true;
  const alt = altIn(html);
  if (alt) e.alt = alt;

  // Older posts (1995-1998) have a generic NASA picture as their featured image;
  // their real one is in the article text.
  const { images, hdurl } = imagesIn(html);
  let image = (p.featured_image_url || '').split('?')[0] || undefined;
  if (!isApodImage(image)) image = images[0]?.url;
  const media = embedIn(html);
  if (!image && media?.poster) image = media.poster;
  if (image) {
    e.image = image;
    const thumb = thumbFrom(image);
    if (thumb && thumb !== image) e.thumb = thumb;
    const size = images.find((i) => i.width && apodPath(i.url) === apodPath(image)) || images.find((i) => i.width);
    if (size) { e.width = size.width; e.height = size.height; }
  } else {
    noImage++;
  }
  if (media) {
    e.media_type = media.media_type;
    if (media.embed) e.embed = decode(media.embed).replace(/^\/\//, 'https://');
  }

  const ex = explanationIn(html);
  if (!ex.text) noText++;
  const creditHtml = rowIn(html, '[^<]*(?:Credit|Copyright)');
  const editors = rowIn(html, 'Authors');
  touchedYears.add(date.slice(0, 4));
  details[date] = Object.fromEntries(Object.entries({
    id: p.id, slug: p.slug, date_gmt: p.date_gmt, modified: p.modified, modified_gmt: p.modified_gmt,
    explanation: ex.text, explanation_html: ex.html, tomorrow: ex.tomorrow,
    credit_html: creditHtml, editors: editors && toText(editors),
    hdurl, images: images.length ? images : undefined,
    author: p.author, coauthors: p.coauthors?.length ? p.coauthors : undefined,
    categories: p.categories, featured_media: p.featured_media || undefined,
  }).filter(([, v]) => v !== undefined && v !== ''));

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
await mkdir(detailsDir, { recursive: true });
for (const year of touchedYears) {
  const days = Object.keys(details).filter((d) => d.startsWith(year)).sort().reverse();
  const yearJson = '{\n' + days.map((d) => `${JSON.stringify(d)}:${JSON.stringify(details[d])}`).join(',\n') + '\n}\n';
  const file = `${detailsDir}/${year}.json`;
  await writeFile(file + '.tmp', yearJson);
  await rename(file + '.tmp', file);
}
console.log(`Saved ${entries.length} entries to ${out} (${added} new, ${updated} refreshed` +
  `${noImage ? `, ${noImage} without an image` : ''}${noCredit ? `, ${noCredit} without a credit` : ''}` +
  `${noText ? `, ${noText} without an explanation` : ''}).`);
if (edited.size) console.log(`  Refreshed ${edited.size} edited ${edited.size === 1 ? 'day' : 'days'}.`);
if (added + updated) console.log('  This run: ' + Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', '));
if (failed) console.error('Some requests failed. Run the same command again to fill in what was missed.');
process.exit(failed ? 1 : 0);
