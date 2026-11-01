#!/usr/bin/env node
// Write _site/about.html: about.md as HTML, placed in about.template.html.
//
//   npm run build   (runs this after assembling _site/)

import { readFile, writeFile } from 'node:fs/promises';
import { marked, Renderer } from 'marked';

const OUT = '_site/about.html';
const PLACEHOLDER = '<!-- about.md -->';

// Links to other sites open in a new tab, as on the grid. Links within the site don't.
marked.use({
  renderer: {
    link(token) {
      const html = Renderer.prototype.link.call(this, token); // marked's own, which cleans and escapes the address
      return /^https?:\/\//.test(token.href) ? html.replace('<a ', '<a target="_blank" rel="noopener" ') : html;
    },
  },
});

const template = await readFile('about.template.html', 'utf8');
if (!template.includes(PLACEHOLDER)) throw new Error(`about.template.html has no ${PLACEHOLDER}`);

const body = marked.parse(await readFile('about.md', 'utf8'));
await writeFile(OUT, template.replace(PLACEHOLDER, () => body));

console.log(`Built about.md into ${OUT} (${(body.length / 1024).toFixed(0)} KB of content).`);
