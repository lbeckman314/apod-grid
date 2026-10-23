#!/usr/bin/env node
// Build the Pagefind search index (pagefind/) from apod.json and apod-details.json.
//
//   npm install
//   npm run build-search
//
// Each day becomes one search record holding its title, credit and explanation. Titles
// are weighted highest, then credits, so a match there ranks above one in an explanation.

import { readFile, rm } from 'node:fs/promises';
import * as pagefind from 'pagefind';

const OUT = 'pagefind';

const entries = JSON.parse(await readFile('apod.json', 'utf8'));
let details = {};
try {
  details = JSON.parse(await readFile('apod-details.json', 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  console.warn('No apod-details.json; indexing titles and credits only.');
}
const explanation = (date) => details[date]?.explanation;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Meta values are read from data- attributes, so they aren't indexed as searchable text.
function page(e) {
  const meta = { title: e.title, date: e.date, link: e.link, image: e.thumb || e.image, image_full: e.image, credit: e.credit, media_type: e.media_type, alt: e.alt };
  const keys = Object.keys(meta).filter((k) => meta[k]);
  const metaAttrs = keys.map((k) => ` data-${k.replace('_', '-')}="${esc(meta[k])}"`).join('');
  const metaSpec = keys.map((k) => `${k}[data-${k.replace('_', '-')}]`).join(', ');
  return `<!doctype html><html lang="en"><body>
<main data-pagefind-body data-pagefind-meta="${metaSpec}" data-pagefind-sort="date[data-date]"${metaAttrs}>
<h1 data-pagefind-weight="10">${esc(e.title)}</h1>
${e.credit ? `<p data-pagefind-weight="5">${esc(e.credit)}</p>` : ''}
${explanation(e.date) ? `<p>${esc(explanation(e.date))}</p>` : ''}
${e.alt ? `<p>${esc(e.alt)}</p>` : ''}
</main></body></html>`;
}

const { index, errors } = await pagefind.createIndex({ forceLanguage: 'en' });
if (!index) throw new Error(`Couldn't start Pagefind: ${errors.join('; ')}`);

let failed = 0;
for (const e of entries) {
  const r = await index.addHTMLFile({ url: e.link, content: page(e) });
  if (r.errors.length) { failed++; console.error(`${e.date}: ${r.errors.join('; ')}`); }
}

await rm(OUT, { recursive: true, force: true });
const w = await index.writeFiles({ outputPath: OUT });
if (w.errors.length) throw new Error(`Couldn't write the index: ${w.errors.join('; ')}`);
await pagefind.close();

console.log(`Indexed ${entries.length - failed} of ${entries.length} days into ${OUT}/` +
  ` (${entries.filter((e) => explanation(e.date)).length} with explanations).`);
process.exit(failed ? 1 : 0);
