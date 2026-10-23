# APOD Grid

A photo-grid view of NASA's [Astronomy Picture of the Day](https://science.nasa.gov/apod/) archive. Each thumbnail links to that day's page on science.nasa.gov.

- `index.html`: the grid. It reads `apod.json` and needs no build step.
- `fetch-apod.mjs`: builds `apod.json` from science.nasa.gov. Requires Node 18 or newer and has no dependencies.
- `.github/workflows/update.yml`: adds each new day to `apod.json` daily.

## Run it locally

```sh
python3 -m http.server   # then open http://localhost:8000
```

Browsers won't load `apod.json` from a `file://` page, so serve the folder over HTTP.

## Updating the data

```sh
node fetch-apod.mjs --update                       # add days newer than the latest in apod.json
node fetch-apod.mjs --last 10                      # the 10 most recent days
node fetch-apod.mjs --start 2024-01-01 --end 2024-01-31
```

Existing entries are kept and merged. Each entry has a `date`, `title`, `link`, and usually an `image` and `thumb`. Days whose article embeds a video, audio, or an interactive page also get a `media_type` (`video`, `audio` or `interactive`) and, where available, the `embed` address. The grid labels those tiles. To build the whole archive (1995 to today) without putting much load on NASA's site, fetch one year at a time with a pause between years:

```sh
for y in $(seq 1995 2026); do
  node fetch-apod.mjs --start $y-01-01 --end $y-12-31 || { echo "Stopped at $y"; break; }
  sleep 30
done
```

If it stops, rerun the loop starting from the year it stopped at.

## Credits

Pictures and text are from NASA's Astronomy Picture of the Day. Some images are copyrighted by their photographers. This site links to NASA's copies and doesn't host any images itself.
