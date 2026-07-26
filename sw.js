// Service worker for WhoShotMe.com — caches a small, fixed allowlist of
// long-lived third-party assets (Leaflet, its clustering plugin, and the
// Poppins font) so a returning visitor's second-and-later page loads skip
// re-downloading them entirely, rather than relying only on the CDN's own
// HTTP cache headers (which whoever's serving cdnjs.cloudflare.com/
// fonts.gstatic.com controls, not us). See lighthousetodo.txt (26/07/2026)
// for the reasoning that led here.
//
// Deliberately narrow scope - this is NOT a general offline-first cache.
// Everything else (the HTML pages themselves, the Google Sheets CSV data,
// map tiles, photographer logo images) is explicitly left to the network/
// browser cache as normal:
//   - HTML pages change on every deploy and must always be network-fresh.
//   - The CSV feeds are live data - caching them here would mean showing
//     stale shoots, exactly the kind of bug CLAUDE.md's "Tommyboy incident"
//     notes already had to fight hard against.
//   - Map tiles are numerous and would bloat the cache for little benefit
///    (they're already viewport-lazy-loaded and browser-cached normally).
//   - Logo images can change if a photographer updates theirs.
const CACHE_NAME = 'whoshotme-cdn-v1';

const CACHEABLE_ORIGINS = [
  'https://cdnjs.cloudflare.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com'
];

// Fetched and cached proactively during install, rather than waiting for
// the runtime fetch handler below to see a request for them first.
// Without this, the SW isn't controlling the page's OWN first-ever
// resource requests (registration itself only happens near the bottom
// of index.html's script, well after leaflet.min.js has already loaded
// via a blocking <script src> at the top - by the time this SW is even
// installing, that request is long finished), so relying purely on the
// runtime handler would mean the cache only gets warmed on the SECOND
// visit (once the SW is finally controlling from page-load time), and
// only actually serves from cache starting the THIRD. Precaching these
// two here means the cache is already warm by the end of visit 1.
// Deliberately excludes leaflet.markercluster.min.js - it's conditional
// (see CLUSTERING_MARKER_THRESHOLD in index.html), and precaching it
// unconditionally here would silently undo that lazy-load work for
// every visitor, including the ones who never need it. It still gets
// cached via the runtime handler below, the first time a visit actually
// requests it.
const PRECACHE_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://fonts.googleapis.com/css2?family=Poppins:wght@900&display=swap'
];

function isCacheable(request){
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return CACHEABLE_ORIGINS.includes(url.origin);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // {cache: 'reload'} bypasses the browser's own HTTP cache for this
      // fetch specifically - without it, a stale disk-cached copy of one
      // of these could get copied straight into our cache instead of a
      // fresh one, defeating the point on the very first write.
      Promise.all(PRECACHE_URLS.map(url =>
        fetch(url, { cache: 'reload' }).then(response => cache.put(url, response))
      ))
    )
  );
  // Take over from any previous version immediately rather than waiting
  // for every open tab to close first - the cache is additive/versioned
  // (see activate below), so there's no risk of an old tab getting a
  // broken half-updated cache out from under it.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (!isCacheable(event.request)) return; // let the browser handle it normally

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // <script src>/<link> tags without a crossorigin attribute fetch
        // cross-origin resources in no-cors mode, which always comes back
        // "opaque" (status 0, body unreadable) even on success - we can't
        // actually tell a real 200 apart from a real error for these, so
        // caching them is a small deliberate bet that cdnjs/fonts.gstatic
        // won't start 404ing a pinned, version-locked URL that's worked
        // fine for a long time. Acceptable here since these are exactly
        // that (Leaflet 1.9.4, markercluster 1.5.3) - not worth chasing a
        // <script crossorigin> rewrite (and CORS headers on the CDN's
        // side actually supporting it) just to avoid this.
        if (response.ok || response.type === 'opaque'){
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
