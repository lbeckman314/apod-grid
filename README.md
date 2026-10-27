# APOD Grid

A photo-grid view of NASA's [Astronomy Picture of the Day](https://science.nasa.gov/apod/) archive. Each thumbnail links to that day's page on science.nasa.gov, and the search box finds days by title, photographer credit or explanation text.

- `index.html`: the grid and search box. It reads `apod.json` and needs no build step.
- `fetch-apod.mjs`: builds `apod.json` and `apod-details/` from science.nasa.gov. Requires Node 18 or newer and has no dependencies.
- `build-search.mjs`: builds the [Pagefind](https://pagefind.app/) search index in `pagefind/`.
- `.github/workflows/update.yml`: daily, adds new days and refreshes days NASA has edited, then builds the search index and deploys the site to GitHub Pages.

The data covers the whole archive: 11,445 days from June 16, 1995 on. NASA's site has 11,446 APOD posts; see [Known gaps](#known-gaps).

## Run it locally

```sh
npm install
npm run build-search     # optional: without it, search covers titles and credits only
python3 -m http.server   # then open http://localhost:8000
```

Browsers won't load `apod.json` from a `file://` page, so serve the folder over HTTP.

## The data

`apod.json` has one entry per day, newest first:

| Field | |
|---|---|
| `date`, `title`, `link` | Always present. `date` is the post's publish date, since a few page addresses have the wrong day. `link` is the day's page on science.nasa.gov. |
| `id`, `modified` | NASA's post ID and when the post was last edited (US Eastern time). |
| `credit` | The image credit, such as `Steve Mandel, Hidden Valley Observatory`. |
| `copyright` | `true` when the credit says the image is copyrighted or licensed, so not public domain. |
| `image`, `thumb` | The full image and a ~480px version for the grid. |
| `width`, `height` | The image's size in pixels. |
| `alt` | A description of the image, where NASA provides one (mostly recent years). |
| `media_type`, `embed` | Only on days whose article embeds a `video`, `audio` or `interactive` page, with its address where available. |

`apod-details/` holds everything else, one file per year (`apod-details/2026.json`), each mapping dates to details. The grid never loads them; only the search index reads them. Splitting by year keeps each file around 1 MB, and a daily update only rewrites the current year.

| Field | |
|---|---|
| `explanation` | The explanation as plain text. |
| `explanation_html` | The explanation as NASA's HTML, with its links. It isn't sanitized, so sanitize it before displaying it. |
| `tomorrow` | The "Tomorrow's picture" teaser, where there is one. |
| `credit_html` | The credit as HTML, with links to the photographers' sites. |
| `editors` | The "Authors & editors" line. |
| `hdurl` | The full-resolution image: the file the picture links to, or else the largest image in the article. |
| `images` | Every APOD image in the article, with `url`, `width` and `height`. |
| `id`, `slug`, `date_gmt`, `modified`, `modified_gmt` | NASA's post details. |
| `author`, `coauthors`, `categories`, `featured_media` | NASA's internal IDs for the post's author, editors, category and image. |

### Known gaps

These come from NASA's migration of APOD to science.nasa.gov, not from the scripts:

- **Days with no post:** 1995-06-17 to 06-19 (APOD didn't post), 2000-06-30, 2004-12-29, 2007-07-13, 2018-04-01 and 2020-06-10.
- **2007-07-16 has two posts**, "Manhattanhenge: A New York Sunset" and "The Lagoon Nebula in Gas, Dust, and Stars". One is probably 2007-07-13, but NASA's pages don't say which. `apod.json` keeps Manhattanhenge.
- **About 16 posts are empty**, with only page navigation, so those days have a title and link but no image, credit or explanation.
- **About 130 days have no image**, mostly Vimeo videos (which offer no free thumbnail) and those empty posts.

## Updating the data

```sh
node fetch-apod.mjs --update                       # add new days, and refresh days NASA has edited
node fetch-apod.mjs --last 10                      # the 10 most recent days
node fetch-apod.mjs --start 2024-01-01 --end 2024-01-31
```

Existing entries are kept and merged, and refetched days are refreshed.

## Rebuilding the archive

To rebuild the whole archive (1995 to today) without putting much load on NASA's site, fetch one year at a time with a pause between years. Each year takes about 4 requests.

```sh
for y in $(seq 1995 2026); do
  node fetch-apod.mjs --start $y-01-01 --end $y-12-31 || { echo "Stopped at $y"; break; }
  sleep 30
done
```

If it stops, rerun the loop starting from the year it stopped at.

## Deploying

The workflow deploys the site with GitHub Actions, so the search index is built fresh and never committed. In the repository's Settings → Pages, set **Source** to **GitHub Actions**.

`npm run build` builds the search index and assembles the deployed files in `_site/`. Both the workflow and Netlify use it.

### Previews

Netlify builds a preview of each pull request, using the settings in `netlify.toml`, and posts its link on the pull request. It skips `main`, since GitHub Pages serves the live site. To set it up, import the repository in Netlify (Add new site → Import an existing project).

## Credits

Pictures and text are from NASA's Astronomy Picture of the Day. Some images are copyrighted by their photographers. This site links to NASA's copies and doesn't host any images itself.
