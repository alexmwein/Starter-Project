import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { createConfig } from '../src/config.mjs';
import { sha256 } from '../src/encoding.mjs';
import {
  createPocketServer,
  reconcileExactUserMessage,
  waitForExactUserMessage,
} from '../src/server.mjs';

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

function postMessage(
  port,
  {
    idempotencyKey,
    message = 'Test message',
    replaceDraft,
    expectedMacDraft,
  },
) {
  const payload = { message };
  if (typeof replaceDraft === 'boolean') payload.replaceDraft = replaceDraft;
  if (typeof expectedMacDraft === 'string') {
    payload.expectedMacDraft = expectedMacDraft;
  }
  const body = JSON.stringify(payload);
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

function postDeliveryStatus(
  port,
  {
    idempotencyKey,
    sessionId = 'test-session',
    deviceId = 'test-device',
  },
) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/sessions/${encodeURIComponent(sessionId)}/delivery-status`,
        method: 'POST',
        headers: {
          Host: '127.0.0.1:4317',
          Origin: 'http://127.0.0.1:4317',
          'Idempotency-Key': idempotencyKey,
          'X-CSRF-Token': 'test-csrf',
          'X-Test-Device': deviceId,
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
    request.end();
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
  assert.match(
    JSON.parse(health.body).configRevision,
    /^[A-Za-z0-9_-]{43}$/,
  );

  const applicationScript = await get(port, { pathname: '/app.js' });
  assert.equal(applicationScript.status, 200);
  assert.equal(applicationScript.headers['cache-control'], 'no-cache');
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
  assert.equal(connection.relayVersion, '0.2.0');
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
  const acceptedRows = [];
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
      getSessionMessageCursor() {
        return acceptedRows.at(-1)?.rowId || 0;
      },
      listUserMessagesAfter(_sessionId, afterRowId) {
        return acceptedRows.filter((row) => row.rowId > afterRowId);
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
        if (retryableSends === 1) {
          return {
            ok: false,
            code: 'accessibility_disabled',
            safeToRetry: true,
          };
        }
        const pressedAt = Math.floor(Date.now() / 1_000) * 1_000;
        acceptedRows.push({
          id: `accepted-${acceptedRows.length + 1}`,
          rowId: acceptedRows.length + 1,
          text: message,
          createdAt: new Date(pressedAt + 100).toISOString(),
          sentAt: new Date(pressedAt + 150).toISOString(),
        });
        return {
          ok: true,
          code: 'sent',
          pressedAt,
          composerOwned: true,
        };
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
  assert.equal(JSON.parse(first.body).error.retrySafe, true);

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
  assert.equal(
    JSON.parse(mappedPermissionFailure.body).error.retrySafe,
    false,
  );

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
  assert.equal(JSON.parse(ambiguous.body).error.retrySafe, false);

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

test('an idempotency key remains bound to the exact send body across safe retries', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  let sends = 0;
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
      getSessionMessageCursor() {
        return 0;
      },
    },
    watcher: createWatcher(),
    transport: {
      async send() {
        sends += 1;
        return {
          ok: false,
          code: 'composer_unavailable',
          safeToRetry: true,
        };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const first = await postMessage(port, {
    idempotencyKey: 'body_bound_retry_key',
    message: 'Original message',
  });
  const changedMessage = await postMessage(port, {
    idempotencyKey: 'body_bound_retry_key',
    message: 'Changed message',
  });
  const changedReplacement = await postMessage(port, {
    idempotencyKey: 'body_bound_retry_key',
    message: 'Original message',
    replaceDraft: true,
    expectedMacDraft: 'Owned draft',
  });
  const exactRetry = await postMessage(port, {
    idempotencyKey: 'body_bound_retry_key',
    message: 'Original message',
  });

  assert.equal(first.status, 503);
  assert.equal(changedMessage.status, 409);
  assert.equal(changedReplacement.status, 409);
  assert.deepEqual(JSON.parse(changedMessage.body).error, {
    code: 'idempotency_key_reused',
  });
  assert.equal(exactRetry.status, 503);
  assert.equal(sends, 2);
});

test('an ambiguous UI result is confirmed by the exact new Conductor row', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  let sends = 0;
  const pressedAt = Math.floor(Date.now() / 1_000) * 1_000;
  const observed = [];
  const server = createPocketServer({
    configStore: { value: config },
    security: {
      assertOrigin() {},
      session(request) {
        return {
          device: {
            id: request.headers['x-test-device'] || 'test-device',
          },
          csrfToken: 'test-csrf',
          unlocked: true,
        };
      },
    },
    database: {
      getSessionRoute(sessionId) {
        return {
          id: sessionId,
          workspaceName: 'Workspace',
          title: 'Chat',
          titleOrdinal: 1,
        };
      },
      getSessionMessageCursor(sessionId) {
        observed.push(['cursor', sessionId]);
        return 41;
      },
      listUserMessagesAfter(sessionId, afterRowId) {
        const exactContent = 'Line one\nLine two';
        observed.push(['match', sessionId, afterRowId, exactContent]);
        return [
          {
            id: 'user-row-42',
            rowId: 42,
            kind: 'user',
            text: exactContent,
            createdAt: new Date(pressedAt + 100).toISOString(),
            sentAt: null,
            cancelledAt: null,
            queued: true,
          },
        ];
      },
    },
    watcher: createWatcher(),
    transport: {
      async send({ message }) {
        sends += 1;
        observed.push(['send', message]);
        return {
          ok: false,
          code: 'send_not_confirmed',
          pressedAt,
          composerOwned: true,
        };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const sent = await postMessage(port, {
    idempotencyKey: 'database_confirmed_key',
    message: 'Line one\r\nLine two',
  });
  const repeated = await postMessage(port, {
    idempotencyKey: 'database_confirmed_key',
    message: 'Line one\r\nLine two',
  });

  assert.equal(sent.status, 200);
  assert.equal(repeated.status, 200);
  assert.equal(sends, 1);
  const receipt = JSON.parse(sent.body);
  assert.equal(receipt.delivery, 'delivered');
  assert.equal(receipt.confirmation, 'database');
  assert.equal(receipt.baselineCursor, 41);
  assert.equal(receipt.rowId, 42);
  assert.deepEqual(observed.slice(0, 3), [
    ['cursor', 'test-session'],
    ['send', 'Line one\nLine two'],
    ['match', 'test-session', 41, 'Line one\nLine two'],
  ]);

  const status = await postDeliveryStatus(port, {
    idempotencyKey: 'database_confirmed_key',
  });
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body).delivery, {
    state: 'delivered',
    deliveredAt: receipt.deliveredAt,
    baselineCursor: 41,
    messageId: 'user-row-42',
    rowId: 42,
  });
  assert.equal(status.body.includes('Line one'), false);

  const wrongSession = await postDeliveryStatus(port, {
    idempotencyKey: 'database_confirmed_key',
    sessionId: 'other-session',
  });
  const wrongDevice = await postDeliveryStatus(port, {
    idempotencyKey: 'database_confirmed_key',
    deviceId: 'other-device',
  });
  assert.deepEqual(JSON.parse(wrongSession.body).delivery, {
    state: 'unknown',
  });
  assert.deepEqual(JSON.parse(wrongDevice.body).delivery, {
    state: 'unknown',
  });
});

test('delivery status recovers a late exact row without resending or exposing content', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  const message = 'Late exact Pocket message';
  const pressedAt = Date.now() - 5_000;
  const exactRow = {
    id: 'late-user-row',
    rowId: 52,
    text: message,
    createdAt: new Date(pressedAt + 4_000).toISOString(),
    sentAt: new Date(pressedAt + 4_100).toISOString(),
  };
  let sends = 0;
  let databaseReads = 0;
  const server = createPocketServer({
    configStore: { value: config },
    security: {
      assertOrigin() {},
      session(request) {
        return {
          device: {
            id: request.headers['x-test-device'] || 'test-device',
          },
          csrfToken: 'test-csrf',
          unlocked: true,
        };
      },
    },
    database: {
      getSessionRoute(sessionId) {
        return {
          id: sessionId,
          workspaceName: 'Workspace',
          title: 'Chat',
          titleOrdinal: 1,
        };
      },
      getSessionMessageCursor() {
        return 51;
      },
      listUserMessagesAfter() {
        databaseReads += 1;
        return [exactRow];
      },
    },
    watcher: createWatcher(),
    transport: {
      async send() {
        sends += 1;
        return {
          ok: false,
          code: 'send_not_confirmed',
          pressedAt,
          composerOwned: true,
        };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const first = await postMessage(port, {
    idempotencyKey: 'late_database_confirmation_key',
    message,
  });
  assert.equal(first.status, 502);
  assert.equal(first.body.includes(message), false);
  assert.equal(first.body.includes('contentHash'), false);

  const readsBeforeWrongScope = databaseReads;
  const wrongSession = await postDeliveryStatus(port, {
    idempotencyKey: 'late_database_confirmation_key',
    sessionId: 'other-session',
  });
  const wrongDevice = await postDeliveryStatus(port, {
    idempotencyKey: 'late_database_confirmation_key',
    deviceId: 'other-device',
  });
  assert.deepEqual(JSON.parse(wrongSession.body).delivery, {
    state: 'unknown',
  });
  assert.deepEqual(JSON.parse(wrongDevice.body).delivery, {
    state: 'unknown',
  });
  assert.equal(databaseReads, readsBeforeWrongScope);

  const readsBeforeRecovery = databaseReads;
  const [status, concurrentStatus] = await Promise.all([
    postDeliveryStatus(port, {
      idempotencyKey: 'late_database_confirmation_key',
    }),
    postDeliveryStatus(port, {
      idempotencyKey: 'late_database_confirmation_key',
    }),
  ]);
  assert.deepEqual(JSON.parse(status.body).delivery, {
    state: 'delivered',
    deliveredAt: exactRow.sentAt,
    baselineCursor: 51,
    messageId: exactRow.id,
    rowId: exactRow.rowId,
  });
  assert.deepEqual(
    JSON.parse(concurrentStatus.body),
    JSON.parse(status.body),
  );
  assert.equal(databaseReads - readsBeforeRecovery, 2);
  assert.equal(status.body.includes(message), false);
  assert.equal(status.body.includes('contentHash'), false);

  const repeated = await postMessage(port, {
    idempotencyKey: 'late_database_confirmation_key',
    message,
  });
  assert.equal(repeated.status, 200);
  assert.equal(JSON.parse(repeated.body).rowId, exactRow.rowId);
  assert.equal(sends, 1);
});

test('delivery status remains pending in-window and recovers the exact row', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  const message = 'Pending exact Pocket message';
  const pressedAt = Date.now();
  const rows = [];
  let sends = 0;
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
      getSessionMessageCursor() {
        return 60;
      },
      listUserMessagesAfter() {
        return rows;
      },
    },
    watcher: createWatcher(),
    transport: {
      async send() {
        sends += 1;
        return {
          ok: false,
          code: 'send_not_confirmed',
          pressedAt,
          composerOwned: true,
        };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const first = await postMessage(port, {
    idempotencyKey: 'pending_database_confirmation_key',
    message,
  });
  const pending = await postDeliveryStatus(port, {
    idempotencyKey: 'pending_database_confirmation_key',
  });

  assert.equal(first.status, 502);
  assert.deepEqual(JSON.parse(pending.body).delivery, {
    state: 'pending',
  });
  assert.equal(pending.body.includes(message), false);
  assert.equal(pending.body.includes('contentHash'), false);

  rows.push({
    id: 'pending-user-row',
    rowId: 61,
    text: message,
    createdAt: new Date().toISOString(),
    sentAt: new Date().toISOString(),
  });
  const delivered = await postDeliveryStatus(port, {
    idempotencyKey: 'pending_database_confirmation_key',
  });

  assert.equal(delivered.status, 200);
  assert.equal(
    JSON.parse(delivered.body).delivery.state,
    'delivered',
  );
  assert.equal(sends, 1);
});

test('delivery status stays fail-closed for an interfering late row', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  const message = 'Expected late Pocket message';
  const pressedAt = Date.now() - 5_000;
  let sends = 0;
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
      getSessionMessageCursor() {
        return 80;
      },
      listUserMessagesAfter() {
        return [
          {
            id: 'late-exact-row',
            rowId: 81,
            text: message,
            createdAt: new Date(pressedAt + 4_000).toISOString(),
          },
          {
            id: 'interfering-user-row',
            rowId: 82,
            text: 'A different user message',
            createdAt: new Date(pressedAt + 4_100).toISOString(),
          },
        ];
      },
    },
    watcher: createWatcher(),
    transport: {
      async send() {
        sends += 1;
        return {
          ok: false,
          code: 'send_not_confirmed',
          pressedAt,
          composerOwned: true,
        };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const first = await postMessage(port, {
    idempotencyKey: 'late_database_interference_key',
    message,
  });
  const status = await postDeliveryStatus(port, {
    idempotencyKey: 'late_database_interference_key',
  });
  const repeated = await postMessage(port, {
    idempotencyKey: 'late_database_interference_key',
    message,
  });

  assert.equal(first.status, 502);
  assert.equal(repeated.status, 502);
  assert.deepEqual(JSON.parse(status.body).delivery, {
    state: 'failed',
    code: 'send_not_confirmed',
    retrySafe: false,
  });
  assert.equal(status.body.includes(message), false);
  assert.equal(status.body.includes('contentHash'), false);
  assert.equal(sends, 1);
});

test('delivery status rejects an exact row outside the recovery window', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  const message = 'Out-of-window Pocket message';
  const pressedAt = Date.now() - 20_000;
  let sends = 0;
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
      getSessionMessageCursor() {
        return 90;
      },
      listUserMessagesAfter() {
        return [
          {
            id: 'out-of-window-row',
            rowId: 91,
            text: message,
            createdAt: new Date(pressedAt + 15_001).toISOString(),
          },
        ];
      },
    },
    watcher: createWatcher(),
    transport: {
      async send() {
        sends += 1;
        return {
          ok: false,
          code: 'send_not_confirmed',
          pressedAt,
          composerOwned: true,
        };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const first = await postMessage(port, {
    idempotencyKey: 'out_of_window_confirmation_key',
    message,
  });
  const status = await postDeliveryStatus(port, {
    idempotencyKey: 'out_of_window_confirmation_key',
  });
  const repeated = await postMessage(port, {
    idempotencyKey: 'out_of_window_confirmation_key',
    message,
  });

  assert.equal(first.status, 502);
  assert.equal(repeated.status, 502);
  assert.deepEqual(JSON.parse(status.body).delivery, {
    state: 'failed',
    code: 'send_not_confirmed',
    retrySafe: false,
  });
  assert.equal(status.body.includes(message), false);
  assert.equal(status.body.includes('contentHash'), false);
  assert.equal(sends, 1);
});

test('a physical-input interruption is delivered when Conductor has the exact new row', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  const interruptedAt = Date.now();
  let sends = 0;
  const exactRow = {
    id: 'user-row-after-interruption',
    rowId: 18,
    kind: 'user',
    text: 'User completed this send',
    createdAt: new Date(interruptedAt + 5_000).toISOString(),
    sentAt: null,
  };
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
      getSessionMessageCursor() {
        return 17;
      },
      listUserMessagesAfter() {
        return [exactRow];
      },
    },
    watcher: createWatcher(),
    transport: {
      async send() {
        sends += 1;
        return {
          ok: false,
          code: 'send_interrupted',
          pressedAt: interruptedAt,
          composerOwned: true,
        };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const response = await postMessage(port, {
    idempotencyKey: 'input_interruption_confirmed_key',
    message: exactRow.text,
  });

  assert.equal(response.status, 200);
  assert.equal(sends, 1);
  const receipt = JSON.parse(response.body);
  assert.equal(typeof receipt.deliveredAt, 'string');
  assert.deepEqual({ ...receipt, deliveredAt: '<timestamp>' }, {
    delivery: 'delivered',
    deliveredAt: '<timestamp>',
    sessionId: 'test-session',
    confirmation: 'database',
    baselineCursor: 17,
    messageId: exactRow.id,
    rowId: exactRow.rowId,
  });
});

test('an interfering user row makes an interrupted send non-retryable', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  const interruptedAt = Date.now();
  let sends = 0;
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
      getSessionMessageCursor() {
        return 20;
      },
      listUserMessagesAfter() {
        return [
          {
            id: 'manual-row',
            rowId: 21,
            text: 'Different manual message',
            createdAt: new Date(interruptedAt + 100).toISOString(),
          },
        ];
      },
    },
    watcher: createWatcher(),
    transport: {
      async send() {
        sends += 1;
        return {
          ok: false,
          code: 'send_interrupted',
          pressedAt: interruptedAt,
          composerOwned: true,
        };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const first = await postMessage(port, {
    idempotencyKey: 'input_interruption_interference_key',
    message: 'Expected Pocket message',
  });
  const repeated = await postMessage(port, {
    idempotencyKey: 'input_interruption_interference_key',
    message: 'Expected Pocket message',
  });

  assert.equal(first.status, 502);
  assert.equal(repeated.status, 502);
  assert.equal(sends, 1);
  assert.deepEqual(JSON.parse(first.body).error, {
    code: 'send_not_confirmed',
    retrySafe: false,
  });
});

test('an interrupted pre-send attempt is retryable only after Conductor stays unchanged', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  const interruptedAt = Date.now();
  let sends = 0;
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
      getSessionMessageCursor() {
        return 25;
      },
      listUserMessagesAfter() {
        return [];
      },
    },
    watcher: createWatcher(),
    transport: {
      async send() {
        sends += 1;
        if (sends === 1) {
          return {
            ok: false,
            code: 'send_interrupted',
            pressedAt: interruptedAt,
            composerOwned: true,
          };
        }
        return {
          ok: false,
          code: 'composer_unavailable',
          safeToRetry: true,
        };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const first = await postMessage(port, {
    idempotencyKey: 'input_interruption_retry_key',
  });
  const retry = await postMessage(port, {
    idempotencyKey: 'input_interruption_retry_key',
  });

  assert.equal(first.status, 409);
  assert.deepEqual(JSON.parse(first.body).error, {
    code: 'user_input_active',
    retrySafe: true,
  });
  assert.equal(retry.status, 503);
  assert.equal(sends, 2);
});

test('a cleared composer without an exact database row is never reported delivered', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  const pressedAt = Math.floor(Date.now() / 1_000) * 1_000;
  let sends = 0;
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
      getSessionMessageCursor() {
        return 7;
      },
      listUserMessagesAfter() {
        return [
          {
            id: 'manual-row',
            rowId: 8,
            text: 'Different manual message',
            createdAt: new Date(pressedAt + 100).toISOString(),
            sentAt: null,
          },
        ];
      },
    },
    watcher: createWatcher(),
    transport: {
      async send() {
        sends += 1;
        return {
          ok: true,
          code: 'sent',
          pressedAt,
          composerOwned: true,
        };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const first = await postMessage(port, {
    idempotencyKey: 'unattributed_success_key',
    message: 'Expected Pocket message',
  });
  const repeated = await postMessage(port, {
    idempotencyKey: 'unattributed_success_key',
    message: 'Expected Pocket message',
  });

  assert.equal(first.status, 502);
  assert.equal(repeated.status, 502);
  assert.equal(sends, 1);
  assert.deepEqual(JSON.parse(first.body).error, {
    code: 'send_not_confirmed',
    retrySafe: false,
  });
});

test('ambiguous-send attribution retries database reads and rejects interference', async () => {
  const pressedAt = Math.floor(Date.now() / 1_000) * 1_000;
  const exact = {
    id: 'user-1',
    rowId: 11,
    kind: 'user',
    text: 'Exact',
    createdAt: new Date(pressedAt + 100).toISOString(),
  };
  let reads = 0;
  const recovered = await waitForExactUserMessage({
    database: {
      listUserMessagesAfter() {
        reads += 1;
        if (reads === 1) throw new Error('briefly busy');
        return [exact];
      },
    },
    sessionId: 'session-1',
    afterRowId: 10,
    exactContent: 'Exact',
    pressedAt,
    composerOwned: true,
    timeoutMs: 100,
    pollMs: 1,
    recheckMs: 1,
  });
  assert.equal(recovered, exact);
  assert.ok(reads >= 3);

  const interfered = await waitForExactUserMessage({
    database: {
      listUserMessagesAfter() {
        return [
          exact,
          {
            ...exact,
            id: 'manual-user-2',
            rowId: 12,
            text: 'Manual message',
          },
        ];
      },
    },
    sessionId: 'session-1',
    afterRowId: 10,
    exactContent: 'Exact',
    pressedAt,
    composerOwned: true,
    timeoutMs: 10,
    pollMs: 1,
    recheckMs: 1,
  });
  assert.equal(interfered, null);

  let mutableRead = 0;
  const changedOnRecheck = await waitForExactUserMessage({
    database: {
      listUserMessagesAfter() {
        mutableRead += 1;
        return [
          mutableRead === 1
            ? exact
            : {
                ...exact,
                text: 'Changed while rechecking',
              },
        ];
      },
    },
    sessionId: 'session-1',
    afterRowId: 10,
    exactContent: 'Exact',
    pressedAt,
    composerOwned: true,
    timeoutMs: 10,
    pollMs: 1,
    recheckMs: 1,
  });
  assert.equal(changedOnRecheck, null);

  let unownedReads = 0;
  const unowned = await waitForExactUserMessage({
    database: {
      listUserMessagesAfter() {
        unownedReads += 1;
        return [exact];
      },
    },
    sessionId: 'session-1',
    afterRowId: 10,
    exactContent: 'Exact',
    pressedAt,
    composerOwned: false,
  });
  assert.equal(unowned, null);
  assert.equal(unownedReads, 0);
});

test('delivery reconciliation handles the post-scan boundary without false failure', async () => {
  const pressedAt = Date.now() - 100;
  const exact = {
    id: 'boundary-user-row',
    rowId: 32,
    text: 'Boundary exact message',
    createdAt: new Date(pressedAt + 50).toISOString(),
    sentAt: new Date(pressedAt + 60).toISOString(),
  };
  let exactReads = 0;
  const delivered = await reconcileExactUserMessage({
    database: {
      listUserMessagesAfter() {
        exactReads += 1;
        return exactReads === 1 ? [] : [exact];
      },
    },
    sessionId: 'session-1',
    afterRowId: 31,
    exactContentHash: sha256(exact.text),
    pressedAt,
    composerOwned: true,
    attributionWindowMs: 15_000,
    timeoutMs: 0,
  });
  assert.equal(delivered.state, 'delivered');
  assert.equal(delivered.match, exact);
  assert.equal(exactReads, 4);

  let interferenceReads = 0;
  const interfered = await reconcileExactUserMessage({
    database: {
      listUserMessagesAfter() {
        interferenceReads += 1;
        return interferenceReads === 1
          ? []
          : [{ ...exact, text: 'Interfering message' }];
      },
    },
    sessionId: 'session-1',
    afterRowId: 31,
    exactContentHash: sha256(exact.text),
    pressedAt,
    composerOwned: true,
    attributionWindowMs: 15_000,
    timeoutMs: 0,
  });
  assert.deepEqual(interfered, { state: 'failed' });

  const expired = await reconcileExactUserMessage({
    database: {
      listUserMessagesAfter() {
        return [];
      },
    },
    sessionId: 'session-1',
    afterRowId: 31,
    exactContentHash: sha256(exact.text),
    pressedAt: Date.now() - 20_000,
    composerOwned: true,
    attributionWindowMs: 15_000,
    timeoutMs: 0,
  });
  assert.deepEqual(expired, { state: 'failed' });
});

test('concurrent identical sends claim distinct post-cursor rows', async (context) => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  let cursor = 0;
  const rows = [];
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
      getSessionMessageCursor() {
        return cursor;
      },
      listUserMessagesAfter(_sessionId, afterRowId) {
        return rows.filter(
          (row) => row.rowId > afterRowId,
        );
      },
    },
    watcher: createWatcher(),
    transport: {
      async send({ message }) {
        await Promise.resolve();
        const pressedAt = Math.floor(Date.now() / 1_000) * 1_000;
        cursor += 1;
        rows.push({
          id: `user-${cursor}`,
          rowId: cursor,
          text: message,
          createdAt: new Date(pressedAt + 100).toISOString(),
          sentAt: new Date(pressedAt + 150).toISOString(),
        });
        return {
          ok: false,
          code: 'send_not_confirmed',
          pressedAt,
          composerOwned: true,
        };
      },
    },
  });
  const port = await listen(server);
  context.after(() => close(server));

  const [first, second] = await Promise.all([
    postMessage(port, {
      idempotencyKey: 'concurrent_identical_key_a',
      message: 'Identical',
    }),
    postMessage(port, {
      idempotencyKey: 'concurrent_identical_key_b',
      message: 'Identical',
    }),
  ]);
  const receipts = [JSON.parse(first.body), JSON.parse(second.body)].sort(
    (left, right) => left.rowId - right.rowId,
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(
    receipts.map((receipt) => [
      receipt.baselineCursor,
      receipt.rowId,
    ]),
    [
      [0, 1],
      [1, 2],
    ],
  );
});

test('service worker handles only Pocket shell paths and Pocket-owned caches', async () => {
  const source = await fs.readFile(
    new URL('../public/service-worker.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /!SHELL_PATHS\.has\(requestUrl\.pathname\)/);
  assert.match(source, /requestUrl\.origin !== self\.location\.origin/);
  assert.match(
    source,
    /key\.startsWith\('conductor-pocket-shell-'\)/,
  );
  assert.match(
    source,
    /matchAll\(\{ type: 'window', includeUncontrolled: true \}\)/,
  );
});

test('sign-out purge removes the Pocket cache and root service worker', async () => {
  const source = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /name\.startsWith\(SHELL_CACHE_PREFIX\)/);
  assert.match(source, /scriptUrl\.pathname === '\/service-worker\.js'/);
  assert.match(source, /registration\.unregister\(\)/);
  assert.match(source, /service_worker_retirement_failed/);
  assert.match(source, /transcript_cache_delete_blocked/);
  assert.doesNotMatch(
    source,
    /requestValue\.onblocked\s*=\s*resolve/,
  );
  assert.match(
    source,
    /if \(currentDevice\) await purgeLocalData\(\);[\s\S]*localPurgeCompleted: true/,
  );
  assert.match(source, /clientVersion: CLIENT_VERSION/);
  assert.match(source, /localStorage\.setItem\(ORIGIN_RETIRED_KEY, '1'\)/);
  assert.match(source, /response\.count !== 1/);
});

test('pending sends persist before draft clearing and recover for the full send window', async () => {
  const source = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const optimisticPush = source.indexOf('state.optimistic.push(optimistic)');
  const requiredPersistence = source.indexOf(
    'await persistPendingDeliveries({ required: true })',
    optimisticPush,
  );
  const draftClear = source.indexOf("field.value = ''", requiredPersistence);
  assert.ok(optimisticPush >= 0);
  assert.ok(requiredPersistence > optimisticPush);
  assert.ok(draftClear > requiredPersistence);
  assert.match(source, /const DELIVERY_RECOVERY_MS = 27_000/);
  assert.match(source, /await restorePendingDeliveries\(\)/);
  assert.match(source, /void recoverPendingDeliveries\(\)/);
  assert.match(
    source,
    /activeDeliveryKey\s*\|\|\s*message\.idempotencyKey/,
  );
  assert.match(
    source,
    /!error\.status\s*\|\|\s*error\.code === 'send_not_confirmed'[\s\S]*await checkDelivery\(optimistic\)/,
  );
});
