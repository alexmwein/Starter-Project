import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { createConfig } from '../src/config.mjs';
import { createPocketServer } from '../src/server.mjs';

function createWatcher() {
  return {
    subscribe() {
      return () => {};
    },
    stop() {},
  };
}

function createServer(config) {
  return createPocketServer({
    configStore: { value: config },
    security: {
      bootstrap() {
        return { authenticated: true, unlocked: false };
      },
      session() {
        return {
          device: { id: 'test-device' },
          csrfToken: 'test-csrf',
          unlocked: true,
        };
      },
    },
    database: {},
    watcher: createWatcher(),
    transport: {
      async doctor() {
        return { ok: true, code: 'ready' };
      },
    },
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function get(port, { pathname = '/', host = '127.0.0.1:4317', method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: { Host: host },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function postMessage(port, { idempotencyKey, message = 'Test message' }) {
  const body = JSON.stringify({ message });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/sessions/test-session/messages',
        method: 'POST',
        headers: {
          Host: '127.0.0.1:4317',
          Origin: 'http://127.0.0.1:4317',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Idempotency-Key': idempotencyKey,
          'X-CSRF-Token': 'test-csrf',
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

test('static shell is hardened, host-checked, and development HTTP is not upgraded', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  const server = createServer(config);
  const port = await listen(server);
  context.after(() => close(server));

  const page = await get(port);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.doesNotMatch(
    page.headers['content-security-policy'],
    /upgrade-insecure-requests/,
  );
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.headers['permissions-policy'], /microphone=\(\)/);
  assert.match(page.body, /id="app"/);

  const head = await get(port, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(head.body, '');

  const denied = await get(port, { host: 'attacker.invalid' });
  assert.equal(denied.status, 403);
  assert.deepEqual(JSON.parse(denied.body), {
    error: { code: 'host_denied' },
  });

  const health = await get(port, { pathname: '/api/health' });
  assert.equal(health.status, 200);
  assert.equal(health.headers['cache-control'], 'no-store, max-age=0');
});

test('production shell emits HTTPS upgrade and HSTS', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'https://mac.example-tailnet.ts.net',
  });
  const server = createServer(config);
  const port = await listen(server);
  context.after(() => close(server));

  const page = await get(port, { host: config.rpId });
  assert.equal(page.status, 200);
  assert.match(
    page.headers['content-security-policy'],
    /upgrade-insecure-requests/,
  );
  assert.match(page.headers['strict-transport-security'], /max-age=31536000/);
});

test('connection probe reports the real relay version', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  const server = createServer(config);
  const port = await listen(server);
  context.after(() => close(server));

  const response = await get(port, { pathname: '/api/connection' });
  assert.equal(response.status, 200);
  const connection = JSON.parse(response.body);
  assert.equal(connection.relayVersion, '0.1.0');
  assert.equal(connection.conductor, true);
  assert.equal(connection.sendPath, true);
});

test('a pre-send failure can retry without weakening ambiguous-send idempotency', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  let retryableSends = 0;
  let ambiguousSends = 0;
  let mappedPermissionFailures = 0;
  let rejectedSends = 0;
  const server = createPocketServer({
    configStore: { value: config },
    security: {
      assertOrigin() {},
      session() {
        return {
          device: { id: 'test-device' },
          csrfToken: 'test-csrf',
          unlocked: true,
        };
      },
    },
    database: {
      getSessionRoute() {
        return {
          id: 'test-session',
          workspaceName: 'Workspace',
          title: 'Chat',
          titleOrdinal: 1,
        };
      },
    },
    watcher: createWatcher(),
    transport: {
      async send({ message }) {
        if (message === 'Mapped permission failure') {
          mappedPermissionFailures += 1;
          return mappedPermissionFailures === 1
            ? { ok: false, code: 'accessibility_disabled' }
            : { ok: true, code: 'sent' };
        }
        if (message === 'Rejected send') {
          rejectedSends += 1;
          throw new Error('transport failed');
        }
        if (message === 'Ambiguous send') {
          ambiguousSends += 1;
          return ambiguousSends === 1
            ? { ok: false, code: 'send_not_confirmed' }
            : { ok: true, code: 'sent' };
        }
        retryableSends += 1;
        return retryableSends === 1
          ? {
              ok: false,
              code: 'accessibility_disabled',
              safeToRetry: true,
            }
          : { ok: true, code: 'sent' };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const first = await postMessage(port, {
    idempotencyKey: 'retryable_failure_key',
  });
  const retry = await postMessage(port, {
    idempotencyKey: 'retryable_failure_key',
  });

  assert.equal(first.status, 503);
  assert.equal(retry.status, 200);
  assert.equal(retryableSends, 2);

  const mappedPermissionFailure = await postMessage(port, {
    idempotencyKey: 'mapped_permission_failure_key',
    message: 'Mapped permission failure',
  });
  const mappedPermissionRetry = await postMessage(port, {
    idempotencyKey: 'mapped_permission_failure_key',
    message: 'Mapped permission failure',
  });

  assert.equal(mappedPermissionFailure.status, 503);
  assert.equal(mappedPermissionRetry.status, 503);
  assert.equal(mappedPermissionFailures, 1);

  const ambiguous = await postMessage(port, {
    idempotencyKey: 'ambiguous_failure_key',
    message: 'Ambiguous send',
  });
  const ambiguousRetry = await postMessage(port, {
    idempotencyKey: 'ambiguous_failure_key',
    message: 'Ambiguous send',
  });

  assert.equal(ambiguous.status, 502);
  assert.equal(ambiguousRetry.status, 502);
  assert.equal(ambiguousSends, 1);

  const rejected = await postMessage(port, {
    idempotencyKey: 'rejected_send_key',
    message: 'Rejected send',
  });
  const rejectedRetry = await postMessage(port, {
    idempotencyKey: 'rejected_send_key',
    message: 'Rejected send',
  });

  assert.equal(rejected.status, 500);
  assert.equal(rejectedRetry.status, 500);
  assert.equal(rejectedSends, 1);
});

test('service worker explicitly bypasses every API request', async () => {
  const source = await fs.readFile(
    new URL('../public/service-worker.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /requestUrl\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(source, /requestUrl\.origin !== self\.location\.origin/);
});
