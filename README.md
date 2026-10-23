# APOD Grid

A photo-grid view of NASA's [Astronomy Picture of the Day](https://science.nasa.gov/apod/) archive. Each thumbnail links to that day's page on science.nasa.gov, and the search box finds days by title, photographer credit or explanation text.

- `index.html`: the grid and search box. It reads `apod.json` and needs no build step.
- `fetch-apod.mjs`: builds `apod.json` and `apod-text.json` from science.nasa.gov. Requires Node 18 or newer and has no dependencies.
- `build-search.mjs`: builds the [Pagefind](https://pagefind.app/) search index in `pagefind/`.
- `.github/workflows/update.yml`: adds each new day daily, builds the search index, and deploys the site to GitHub Pages.

The data currently covers 2026 only, while the fields settle. See [Building the archive](#building-the-archive) to add earlier years.

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
| `date`, `title`, `link` | Always present. `link` is the day's page on science.nasa.gov. |
| `credit` | The image credit, such as `Steve Mandel, Hidden Valley Observatory`. |
| `image`, `thumb` | The full image and a ~480px version for the grid. |
| `media_type`, `embed` | Only on days whose article embeds a `video`, `audio` or `interactive` page, with its address where available. |

`apod-text.json` maps each date to its explanation text. Only the search index uses it, so the grid never loads it.

## Updating the data

```sh
node fetch-apod.mjs --update                       # add days newer than the latest in apod.json
node fetch-apod.mjs --last 10                      # the 10 most recent days
node fetch-apod.mjs --start 2024-01-01 --end 2024-01-31
```

Existing entries are kept and merged, and refetched days are refreshed.

## Building the archive

To add the whole archive (1995 to today) without putting much load on NASA's site, fetch one year at a time with a pause between years. Each year takes about 4 requests.

```sh
for y in $(seq 1995 2025); do
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
