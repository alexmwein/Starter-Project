const CACHE = 'conductor-pocket-shell-v14';
const SHELL = [
  '/',
  '/index.html',
  '/app.css?v=0.2.0-focused-turns-20260728',
  '/app.js?v=0.2.0-focused-turns-20260728',
  '/delivery-receipts.js?v=0.2.0-focused-turns-20260728',
  '/app-update.js?v=0.2.0-focused-turns-20260728',
  '/http.js?v=0.2.0-focused-turns-20260728',
  '/live-refresh.js?v=0.2.0-focused-turns-20260728',
  '/rich-text.js?v=0.2.0-focused-turns-20260728',
  '/transcript-focus.js?v=0.2.0-focused-turns-20260728',
  '/icon.svg',
  '/manifest.webmanifest',
];
const SHELL_PATHS = new Set([
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/delivery-receipts.js',
  '/app-update.js',
  '/http.js',
  '/live-refresh.js',
  '/rich-text.js',
  '/transcript-focus.js',
  '/icon.svg',
  '/manifest.webmanifest',
]);
const VERSIONED_SHELL_PATHS = new Set([
  '/app.css',
  '/app.js',
  '/delivery-receipts.js',
  '/app-update.js',
  '/http.js',
  '/live-refresh.js',
  '/rich-text.js',
  '/transcript-focus.js',
]);

function fetchAndCache(request) {
  return fetch(request).then((response) => {
    if (response.ok) {
      const clone = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(request, clone));
    }
    return response;
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) =>
                  key.startsWith('conductor-pocket-shell-') &&
                  key !== CACHE,
              )
              .map((key) => caches.delete(key)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener('message', (event) => {
  if (
    event.data?.type !== 'retirement-window-count' ||
    !event.ports?.[0]
  ) {
    return;
  }
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        event.ports[0].postMessage({
          type: 'retirement-window-count',
          requestId: event.data.requestId,
          count: clients.length,
        });
      }),
  );
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    requestUrl.origin !== self.location.origin ||
    !SHELL_PATHS.has(requestUrl.pathname)
  ) {
    return;
  }
  const versionedAsset =
    VERSIONED_SHELL_PATHS.has(requestUrl.pathname) &&
    requestUrl.searchParams.has('v');
  if (versionedAsset) {
    event.respondWith(
      caches
        .match(event.request)
        .then((response) => response || fetchAndCache(event.request))
        .catch(() => caches.match('/')),
    );
    return;
  }
  event.respondWith(
    fetchAndCache(event.request)
      .catch(() => caches.match(event.request).then((response) => response || caches.match('/'))),
  );
});
