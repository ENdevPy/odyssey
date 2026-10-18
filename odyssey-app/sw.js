/* Odyssey offline support. The app shell and map data are cached so the app
   opens instantly and still works with no signal (live tide, flood warnings
   and place search need a connection and say so when offline). */
const VERSION = "odyssey-v9";
const SHELL = [
  "./", "index.html", "style.css?v=7", "app.js?v=7", "ui.js?v=7",
  "vendor/leaflet.js", "vendor/leaflet.css", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png",
];
const DATA = [
  "data/path_segments.json", "data/safe_havens.json", "data/model.json",
  "data/live_check.json", "data/data_manifest.json", "data/basemap.geojson",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).then(() => c.addAll(DATA).catch(() => {}))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Same-origin files: serve from cache straight away, refresh it in the background.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(e.request);
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
