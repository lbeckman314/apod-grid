#!/usr/bin/env node
// Write _site/index.html: index.html with the newest few months of apod.json built in,
// so the grid shows them right away while the full archive loads in the background.
//
//   npm run build   (runs this after assembling _site/)

import { readFile, writeFile } from 'node:fs/promises';

const MONTHS = 3;
const OUT = '_site/index.html';
const PLACEHOLDER = '<script type="application/json" id="seed"></script>';

const html = await readFile('index.html', 'utf8');
if (!html.includes(PLACEHOLDER)) throw new Error(`index.html has no ${PLACEHOLDER}`);

const entries = JSON.parse(await readFile('apod.json', 'utf8'))
  .filter((e) => e && e.date && e.link)
  .sort((a, b) => (a.date < b.date ? 1 : -1));
// Whole months only, so the page can carry on from apod.json where these end.
const keys = new Set([...new Set(entries.map((e) => e.date.slice(0, 7)))].slice(0, MONTHS));
const recent = entries.filter((e) => keys.has(e.date.slice(0, 7)));

let out = html;
if (recent.length) {
  const seed = { total: entries.length, earliest: entries[entries.length - 1].date, recent };
  // < keeps a "</script>" in a title from ending the script element.
  const json = JSON.stringify(seed).replace(/</g, '\\u003c');
  out = html.replace(PLACEHOLDER, () => PLACEHOLDER.replace('><', `>${json}<`));
}
await writeFile(OUT, out);

console.log(`Built ${recent.length} days (${keys.size} months) into ${OUT} (${(out.length / 1024).toFixed(0)} KB).`);
