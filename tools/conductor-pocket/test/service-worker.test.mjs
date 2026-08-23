import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const ORIGIN = 'https://pocket.test';
const PREVIOUS_CACHE = 'conductor-pocket-shell-v24';
const CURRENT_CACHE = 'conductor-pocket-shell-v25';

function requestKey(request) {
  const value = typeof request === 'string' ? request : request.url;
  return new URL(value, ORIGIN).href;
}

function createCacheStorage({ fetchImpl, failInstall = false } = {}) {
  const stores = new Map();
  const apiFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async match(request) {
        return store.get(requestKey(request))?.clone();
      },
      async put(request, response) {
        store.set(requestKey(request), response.clone());
      },
      async delete(request) {
        return store.delete(requestKey(request));
      },
      async addAll(urls) {
        for (const [index, url] of urls.entries()) {
          const response = await fetchImpl(new Request(requestKey(url)));
          store.set(requestKey(url), response.clone());
          if (failInstall && index === 0) throw new Error('partial_install');
        }
      },
    };
  };
  return {
    stores,
    async open(name) {
      return apiFor(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
}

async function loadWorker({ fetchImpl, failInstall = false } = {}) {
  const source = await fs.readFile(
    new URL('../public/service-worker.js', import.meta.url),
    'utf8',
  );
  const listeners = new Map();
  const caches = createCacheStorage({ fetchImpl, failInstall });
  let skipWaitingCalls = 0;
  const self = {
    location: { origin: ORIGIN },
    clients: {
      async claim() {},
      async matchAll() {
        return [];
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    async skipWaiting() {
      skipWaitingCalls += 1;
    },
  };
  vm.runInNewContext(source, {
    caches,
    fetch: fetchImpl,
    self,
    URL,
    Request,
    Response,
    Set,
    Error,
    Promise,
  });
  return { caches, listeners, skipWaitingCalls: () => skipWaitingCalls };
}

async function dispatchFetch(listener, request) {
  let responsePromise;
  listener({
    request,
    respondWith(value) {
      responsePromise = Promise.resolve(value);
    },
  });
  assert.ok(responsePromise, 'worker should handle this request');
  return responsePromise;
}

test('an old worker serves its own document while a newer cache exists', async () => {
  let networkCalls = 0;
  const worker = await loadWorker({
    fetchImpl: async () => {
      networkCalls += 1;
      return new Response('<p>network-new</p>', {
        headers: { 'Content-Type': 'text/html' },
      });
    },
  });
  const current = await worker.caches.open(CURRENT_CACHE);
  await current.put(
    '/index.html',
    new Response('<p>current-generation</p>', {
      headers: { 'Content-Type': 'text/html' },
    }),
  );
  const newer = await worker.caches.open('conductor-pocket-shell-v26');
  await newer.put(
    '/index.html',
    new Response('<p>other-generation</p>', {
      headers: { 'Content-Type': 'text/html' },
    }),
  );

  const response = await dispatchFetch(
    worker.listeners.get('fetch'),
    new Request(`${ORIGIN}/?appRevision=new`),
  );
  assert.equal(await response.text(), '<p>current-generation</p>');
  assert.equal(networkCalls, 0);
});

test('script and style requests reject cached or network HTML', async () => {
  const worker = await loadWorker({
    fetchImpl: async () =>
      new Response('<!doctype html><p>fallback</p>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
  });
  const current = await worker.caches.open(CURRENT_CACHE);
  const scriptRequest = new Request(`${ORIGIN}/app.js?v=missing`);
  await current.put(
    scriptRequest,
    new Response('<!doctype html><p>cached fallback</p>', {
      headers: { 'Content-Type': 'text/html' },
    }),
  );

  await assert.rejects(
    dispatchFetch(worker.listeners.get('fetch'), scriptRequest),
    /shell_asset_content_type_mismatch/,
  );
  assert.equal(await current.match(scriptRequest), undefined);
});

test('a failed network response cannot satisfy a module request', async () => {
  const worker = await loadWorker({
    fetchImpl: async () => Response.error(),
  });
  await assert.rejects(
    dispatchFetch(
      worker.listeners.get('fetch'),
      new Request(`${ORIGIN}/app.js?v=network-error`),
    ),
    /shell_asset_content_type_mismatch/,
  );
});

test('document fallback accepts only successful cached HTML', async () => {
  const worker = await loadWorker({
    fetchImpl: async () => {
      throw new Error('navigation_must_not_use_network');
    },
  });
  const current = await worker.caches.open(CURRENT_CACHE);
  await current.put(
    '/index.html',
    new Response('not a document', {
      headers: { 'Content-Type': 'text/plain' },
    }),
  );
  await current.put(
    '/',
    new Response('<p>valid document</p>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
  );

  const response = await dispatchFetch(
    worker.listeners.get('fetch'),
    new Request(`${ORIGIN}/`),
  );
  assert.equal(await response.text(), '<p>valid document</p>');
  assert.equal(await current.match('/index.html'), undefined);
});

test('a partial shell installation is deleted and never activates', async () => {
  const worker = await loadWorker({
    failInstall: true,
    fetchImpl: async () =>
      new Response('<!doctype html><p>shell</p>', {
        headers: { 'Content-Type': 'text/html' },
      }),
  });
  let installPromise;
  worker.listeners.get('install')({
    waitUntil(value) {
      installPromise = Promise.resolve(value);
    },
  });

  await assert.rejects(installPromise, /partial_install/);
  assert.equal(worker.caches.stores.has(CURRENT_CACHE), false);
  assert.equal(worker.skipWaitingCalls(), 0);
});

test('a failed new worker install preserves the active prior shell', async () => {
  const worker = await loadWorker({
    failInstall: true,
    fetchImpl: async () =>
      new Response('<!doctype html><p>new shell</p>', {
        headers: { 'Content-Type': 'text/html' },
      }),
  });
  const previous = await worker.caches.open(PREVIOUS_CACHE);
  await previous.put(
    '/index.html',
    new Response('<p>active prior shell</p>', {
      headers: { 'Content-Type': 'text/html' },
    }),
  );
  let installPromise;
  worker.listeners.get('install')({
    waitUntil(value) {
      installPromise = Promise.resolve(value);
    },
  });

  await assert.rejects(installPromise, /partial_install/);
  assert.equal(worker.caches.stores.has(CURRENT_CACHE), false);
  assert.equal(worker.caches.stores.has(PREVIOUS_CACHE), true);
  assert.equal(
    await (await previous.match('/index.html')).text(),
    '<p>active prior shell</p>',
  );
  assert.equal(worker.skipWaitingCalls(), 0);
});

test('an install with HTML in a module slot is deleted and never activates', async () => {
  const worker = await loadWorker({
    fetchImpl: async (request) => {
      const pathname = new URL(request.url).pathname;
      const contentType =
        pathname === '/' || pathname === '/index.html'
          ? 'text/html'
          : pathname === '/app.css'
            ? 'text/css'
            : pathname.endsWith('.js')
              ? pathname === '/app.js'
                ? 'text/html'
                : 'text/javascript'
              : 'application/octet-stream';
      return new Response('shell', {
        headers: { 'Content-Type': contentType },
      });
    },
  });
  let installPromise;
  worker.listeners.get('install')({
    waitUntil(value) {
      installPromise = Promise.resolve(value);
    },
  });

  await assert.rejects(installPromise, /shell_asset_content_type_mismatch/);
  assert.equal(worker.caches.stores.has(CURRENT_CACHE), false);
  assert.equal(worker.skipWaitingCalls(), 0);
});
