// Astro builds the site into dist/: the grid (src/pages/index.astro), the About page
// (src/pages/about.md) and apod.json (src/pages/apod.json.js). npm run build then adds
// the Pagefind search index (build-search.mjs).
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import rehypeExternalLinks from 'rehype-external-links';

export default defineConfig({
  // index.html and about.html, as before, rather than about/index.html.
  build: { format: 'file' },
  // Links to other sites open in a new tab, as on the grid. rehype plugins need the unified
  // processor rather than Astro's default (Sätteri).
  markdown: {
    processor: unified({ rehypePlugins: [[rehypeExternalLinks, { target: '_blank', rel: ['noopener'] }]] }),
  },
});
