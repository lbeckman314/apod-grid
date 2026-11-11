// A service worker that keeps NASA's images on the visitor's device, so the grid doesn't
// fetch the same thumbnails again on later visits. index.astro registers it. It handles only
// images from assets.science.nasa.gov; every other request goes to the network as usual.
//
// A cached image is used for 30 days without asking NASA. After that, or when the cache
// holds too much, it's fetched again. If NASA's server fails, an expired copy is still used.

const CACHE = 'nasa-images-v1';
const HOST = 'assets.science.nasa.gov';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Thumbnails average about 27 KB, so this is about 80 MB.
const MAX_ENTRIES = 3000;
// Thumbnails are well under this. It keeps out the full-size images and GIFs the grid
// falls back to, which can be several megabytes each.
const MAX_BYTES = 1024 * 1024;
const CACHED_AT = 'x-apod-grid-cached-at';
// How many new images to add between checks of the cache's size.
const TRIM_EVERY = 100;

let added = 0;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Remove caches from earlier versions of this file.
    for (const name of await caches.keys()) {
      if (name.startsWith('nasa-images-') && name !== CACHE) await caches.delete(name);
    }
    // Take over the open page now rather than at its next load.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.destination !== 'image') return;
  if (new URL(request.url).hostname !== HOST) return;
  event.respondWith(fromCache(request, event));
});

async function fromCache(request, event) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request.url);
  if (hit && Date.now() - Number(hit.headers.get(CACHED_AT)) < MAX_AGE_MS) return hit;

  // The <img> asks without CORS, which would give an opaque response. Browsers count each
  // opaque response as megabytes against the site's storage quota, so ask with CORS instead
  // (NASA allows it) to store just the image's real size.
  let res;
  try {
    res = await fetch(request.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    // Offline, or a host that refuses CORS: use an expired copy, or else let the browser try.
    return hit || fetch(request);
  }
  if (!res.ok) return hit || res;

  const body = await res.blob();
  const headers = new Headers(res.headers);
  headers.set(CACHED_AT, String(Date.now()));
  const fresh = new Response(body, { status: res.status, statusText: res.statusText, headers });
  if (body.size <= MAX_BYTES) event.waitUntil(store(cache, request.url, fresh.clone()));
  return fresh;
}

async function store(cache, url, res) {
  await cache.put(url, res);
  if (++added % TRIM_EVERY) return;
  // Cache keys come back oldest first, so drop from the front.
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(key);
}
