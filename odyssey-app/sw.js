/* Odyssey offline support. The app shell and map data are cached so the app
   opens instantly and still works with no signal (live tide, flood warnings
   and place search need a connection and say so when offline). */
const VERSION = "odyssey-v16";
const SHELL = [
  "./", "index.html", "style.css?v=14", "app.js?v=14", "ui.js?v=14",
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
  // The page itself and the service worker: always try the network first, so an
  // update shows on the very next open. Fall back to the saved copy offline.
  const isPage = e.request.mode === "navigate" || /\/(index\.html)?$/.test(url.pathname);
  if (isPage) {
    e.respondWith(caches.open(VERSION).then((cache) =>
      fetch(e.request, { cache: "no-store" }).then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      }).catch(async () => (await cache.match(e.request)) || cache.match("index.html"))));
    return;
  }
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(e.request);
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
