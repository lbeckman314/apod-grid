---
layout: ../layouts/About.astro
---

## What this is

APOD Grid shows NASA's [Astronomy Picture of the Day](https://science.nasa.gov/apod/) archive as one long wall of photos: every day since June 16, 1995, newest first, a month at a time.

Each picture links to that day's page on science.nasa.gov, where you'll find the full image and its explanation. This site is a fan project for browsing; it isn't affiliated with or endorsed by NASA.

## Using it

- **Scroll** Older months load as you reach them. Hover over a picture for its date, title and credit.
- **Timeline** The column on the right covers the whole archive, newest at the top. The yellow line marks where you are. Click or drag anywhere on it to go to that month, or click a year to go to the start of that year. With the timeline focused, the arrow keys move a month, Page Up and Page Down move a year, and Home and End go to either end.
- **Search** Finds days by title, photographer credit or explanation text. Matches in titles rank first, then credits.
- **Links** The address keeps the month you're looking at, so you can bookmark or share it. `?date=2014-08` opens a month, `?date=2014` opens the end of a year, and `?date=2014-08-24` opens a month and outlines that day's picture.

## How we built it

The site is a small [Astro](https://astro.build/) project: the grid page, this page, and data files kept in the repository. It builds to plain static files, so there's no server or database.

### Fetching the archive

APOD moved to science.nasa.gov, which runs on WordPress. `fetch-apod.mjs` reads its public JSON API (no key needed), asking only for posts in the APOD category, 100 at a time, with a one-second pause between requests to go easy on NASA's site. For each day it keeps the title, link, image, a roughly 480-pixel thumbnail, the photographer credit, whether the image is copyrighted, and NASA's alt text where there is one. It also notes days whose article embeds a video, audio or interactive page.

We backfilled the full archive one year at a time, a few requests per year. Days are dated by their publish date, because a few page addresses carry the wrong day.

### Keeping the data small

The grid only needs a little about each day, so `apod.json` holds just that. Everything else (the explanation as text and HTML, credit links, editors, full-resolution links, and every image's size) goes in `apod-details/`, one file per year. The grid never loads those files, and a daily update only rewrites the current year.

### Staying up to date

A GitHub Actions workflow runs every day at 06:17 UTC, a couple of hours after the new picture posts. It adds new days, refreshes any day NASA has edited, commits the changes, and redeploys the site to GitHub Pages. Netlify builds a preview of each pull request.

### Search

When the site deploys, `build-search.mjs` builds a [Pagefind](https://pagefind.app/) index from every day's title, credit, explanation and alt text. The browser downloads only the small slices of the index a search needs. Without the index, as when running the site straight from the folder, search falls back to titles and credits.

### Loading instantly

The full `apod.json` is several megabytes. So that the grid never waits for it, the page's build step puts the newest three months straight into the page. Those show right away while the rest of the archive loads in the background.

### Browsing

The grid draws a few months at a time and adds more as you scroll, so the page stays light however far back you go. The timeline is drawn on a canvas with one hash per month (fewer when space is tight), styled after the straightening dial in the iOS photo editor. It follows the page as you scroll and moves the page as you drag.

### Writing this page

This page is written in Markdown, in `src/pages/about.md`. Astro turns it into HTML and places it in a layout, `src/layouts/About.astro`, which holds the page's styles, toolbar and footer.

## The data

The archive covers more than 11,400 days. Some gaps come from NASA's migration to science.nasa.gov rather than from this site:

- A few days have no post: 1995-06-17 to 06-19 (APOD didn't post), 2000-06-30, 2004-12-29, 2007-07-13, 2018-04-01 and 2020-06-10.
- 2007-07-16 has two posts; one is probably 2007-07-13, but NASA's pages don't say which.
- About 16 posts are empty, so those days have a title and link but no picture.
- About 130 days have no image to show, mostly Vimeo videos, which offer no free thumbnail.

Both files are in the repository, and the [README](https://github.com/lbeckman314/apod-grid#the-data) lists every field.

## Credits and copyright

The pictures and text come from NASA's Astronomy Picture of the Day, written and edited by Robert Nemiroff and Jerry Bonnell. Many images are copyrighted by their photographers and aren't public domain; each tile's credit names them. This site doesn't host any images. Every thumbnail loads from NASA's own copy.

## Run it yourself

The code is on [GitHub](https://github.com/lbeckman314/apod-grid). You need Node 22.22 or newer.

```sh
npm install
npm run dev       # then open http://localhost:4321
```

The development server reloads as you edit. It has no search index, so search covers titles and credits only. To try the site as deployed, with full search:

```sh
npm run build     # the site and its search index, in dist/
npm run preview
```
