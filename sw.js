// Bump this alongside APP_VERSION in app.js whenever a change ships — it's
// what forces the cached app shell to refresh instead of serving a stale
// version indefinitely.
const CACHE_VERSION = "v14";
const CACHE_NAME = `todo-shell-${CACHE_VERSION}`;

// Same-origin app shell, plus the three pinned-version Firebase SDK files —
// those specific URLs never change content (immutable, 1-year cache
// headers), so caching them here is safe and lets the app boot offline
// even on a cold start with nothing else cached yet.
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js",
];

// Firestore's and Auth's own network traffic (firestore.googleapis.com,
// identitytoolkit.googleapis.com, accounts.google.com and friends) must
// never be touched by this worker — none of it is simple cacheable
// request/response traffic, and both SDKs already manage their own offline
// queueing and reconnection.
const CACHEABLE_ORIGINS = new Set([self.location.origin, "https://www.gstatic.com"]);

// Fetches one precache URL with a timeout, so a single slow or unreachable
// asset (most likely the cross-origin Firebase URLs) can't wedge install
// forever — cache.addAll() would, since it's all-or-nothing with no timeout.
// Failures are swallowed: a partially-filled cache still lets the app shell
// load offline, which matters more than precaching being complete.
function precacheOne(cache, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  return fetch(url, { signal: controller.signal })
    .then((response) => {
      if (response.ok) return cache.put(url, response);
    })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(PRECACHE_URLS.map((url) => precacheOne(cache, url))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || !CACHEABLE_ORIGINS.has(url.origin)) return;

  // Cache-first for instant offline loads, with a background refetch to
  // keep the cache from going stale while the app is used online.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
