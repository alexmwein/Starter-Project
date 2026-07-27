const CACHE = 'conductor-pocket-shell-v4';
const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js?v=0.2.0-delivery-fix-2',
  '/delivery-receipts.js?v=0.2.0-delivery-fix-2',
  '/icon.svg',
  '/manifest.webmanifest',
];
const SHELL_PATHS = new Set([
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/delivery-receipts.js',
  '/icon.svg',
  '/manifest.webmanifest',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
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
  );
  self.clients.claim();
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
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((response) => response || caches.match('/'))),
  );
});
