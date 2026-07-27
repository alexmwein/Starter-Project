import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  brotliCompress,
  constants as zlibConstants,
} from 'node:zlib';
import {
  APP_NAME,
  APP_VERSION,
  MAX_JSON_BODY_BYTES,
  SSE_HEARTBEAT_MS,
} from './constants.mjs';
import { configRevision, getVerificationCode } from './config.mjs';
import { normalizeText, sha256 } from './encoding.mjs';
import { HttpError, asHttpError } from './errors.mjs';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const SEND_CONFIRMATION_TIMEOUT_MS = 5_000;
const SEND_CONFIRMATION_POLL_MS = 50;
const SEND_ATTRIBUTION_WINDOW_MS = 3_000;
const SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS = 60_000;
const SEND_ATTRIBUTION_RECHECK_MS = 400;
const SEND_DELIVERY_RECOVERY_ATTRIBUTION_WINDOW_MS = 15_000;
const SEND_DELIVERY_RECOVERY_TIMEOUT_MS = 1_000;
const brotliCompressAsync = promisify(brotliCompress);
const staticAssetCache = new Map();

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  [
    '/delivery-receipts.js',
    ['delivery-receipts.js', 'text/javascript; charset=utf-8'],
  ],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/service-worker.js', ['service-worker.js', 'text/javascript; charset=utf-8']],
]);

const errorStatuses = new Map([
  ['draft_conflict', 409],
  ['draft_recheck_required', 409],
  ['message_empty', 400],
  ['message_invalid', 400],
  ['message_too_large', 413],
  ['workspace_list_unavailable', 503],
  ['workspace_not_visible', 503],
  ['session_not_visible', 503],
  ['composer_unavailable', 503],
  ['composer_update_failed', 502],
  ['conductor_not_running', 503],
  ['conductor_window_unavailable', 503],
  ['accessibility_disabled', 503],
  ['session_locked', 503],
  ['send_unavailable', 503],
  ['send_failed', 502],
  ['user_input_active', 409],
  ['send_not_confirmed', 502],
  ['automation_timeout', 504],
  ['automation_failed', 502],
  ['automation_invalid_response', 502],
]);

function securityHeaders(config, { api = false } = {}) {
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ];
  if (config.publicOrigin.startsWith('https://')) {
    contentSecurityPolicy.push('upgrade-insecure-requests');
  }
  const headers = {
    'Content-Security-Policy': contentSecurityPolicy.join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy':
      'camera=(), geolocation=(), microphone=(), payment=(), usb=(), serial=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
  if (config.publicOrigin.startsWith('https://')) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  if (api) headers['Cache-Control'] = 'no-store, max-age=0';
  return headers;
}

function sendJson(response, status, value, config, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...securityHeaders(config, { api: true }),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

async function readJson(request) {
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (declaredLength > MAX_JSON_BODY_BYTES) {
    throw new HttpError(413, 'request_too_large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) throw new HttpError(413, 'request_too_large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function idempotencyKey(request) {
  const value = request.headers['idempotency-key'];
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 100 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new HttpError(400, 'idempotency_key_required');
  }
  return value;
}

function pathMatch(pathname, expression) {
  const match = expression.exec(pathname);
  if (!match) return null;
  return match.slice(1).map((value) => decodeURIComponent(value));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForExactUserMessage({
  database,
  sessionId,
  afterRowId,
  exactContent,
  exactContentHash,
  pressedAt,
  composerOwned,
  timeoutMs = SEND_CONFIRMATION_TIMEOUT_MS,
  pollMs = SEND_CONFIRMATION_POLL_MS,
  recheckMs = SEND_ATTRIBUTION_RECHECK_MS,
  attributionWindowMs = SEND_ATTRIBUTION_WINDOW_MS,
}) {
  if (
    composerOwned !== true ||
    !Number.isSafeInteger(pressedAt) ||
    pressedAt <= 0 ||
    (typeof exactContent !== 'string' &&
      (typeof exactContentHash !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(exactContentHash)))
  ) {
    return null;
  }
  const contentMatches = (message) =>
    typeof message?.text === 'string' &&
    (typeof exactContent === 'string'
      ? message.text === exactContent
      : sha256(message.text) === exactContentHash);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    try {
      const messages = database.listUserMessagesAfter(
        sessionId,
        afterRowId,
      );
      if (messages.length > 0) {
        if (messages.length !== 1) return null;
        const [match] = messages;
        const createdAt = Date.parse(match.createdAt);
        if (
          typeof match.id !== 'string' ||
          match.id.length === 0 ||
          !Number.isSafeInteger(match.rowId) ||
          match.rowId <= afterRowId ||
          !contentMatches(match) ||
          !Number.isFinite(createdAt) ||
          createdAt < pressedAt ||
          createdAt > pressedAt + attributionWindowMs
        ) {
          return null;
        }
        await delay(Math.max(0, recheckMs));
        const rechecked = database.listUserMessagesAfter(
          sessionId,
          afterRowId,
        );
        const recheckedMatch = rechecked[0];
        const recheckedCreatedAt = Date.parse(recheckedMatch?.createdAt);
        if (
          rechecked.length === 1 &&
          recheckedMatch.id === match.id &&
          recheckedMatch.rowId === match.rowId &&
          contentMatches(recheckedMatch) &&
          Number.isFinite(recheckedCreatedAt) &&
          recheckedCreatedAt >= pressedAt &&
          recheckedCreatedAt <= pressedAt + attributionWindowMs
        ) {
          return recheckedMatch;
        }
        return null;
      }
    } catch {
      // SQLite can be briefly busy while Conductor commits the user row.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await delay(Math.min(Math.max(1, pollMs), remaining));
  } while (true);
}

export async function reconcileExactUserMessage({
  database,
  sessionId,
  afterRowId,
  exactContentHash,
  pressedAt,
  composerOwned,
  attributionWindowMs,
  timeoutMs = SEND_DELIVERY_RECOVERY_TIMEOUT_MS,
}) {
  const reconcile = (candidateTimeoutMs) =>
    waitForExactUserMessage({
      database,
      sessionId,
      afterRowId,
      exactContentHash,
      pressedAt,
      composerOwned,
      timeoutMs: candidateTimeoutMs,
      attributionWindowMs,
    });
  let match = await reconcile(timeoutMs);
  if (match) return { state: 'delivered', match };
  if (Date.now() > pressedAt + attributionWindowMs) {
    return { state: 'failed' };
  }
  try {
    const rows = database.listUserMessagesAfter(sessionId, afterRowId);
    if (rows.length === 0) return { state: 'pending' };
  } catch {
    return { state: 'pending' };
  }
  match = await reconcile(0);
  return match
    ? { state: 'delivered', match }
    : { state: 'failed' };
}

function databaseDeliveryResult(match, baselineCursor) {
  return {
    ok: true,
    code: 'sent',
    confirmation: 'database',
    messageId: match.id,
    rowId: match.rowId,
    sentAt: match.sentAt,
    deliveredAt: match.sentAt || new Date().toISOString(),
    baselineCursor,
  };
}

function sendNotConfirmedResult({
  baselineCursor,
  contentHash,
  pressedAt,
  composerOwned,
  attributionWindowMs = SEND_DELIVERY_RECOVERY_ATTRIBUTION_WINDOW_MS,
}) {
  const result = {
    ok: false,
    code: 'send_not_confirmed',
    pressedAt,
    composerOwned,
  };
  if (
    Number.isSafeInteger(baselineCursor) &&
    baselineCursor >= 0 &&
    typeof contentHash === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(contentHash) &&
    Number.isSafeInteger(pressedAt) &&
    pressedAt > 0 &&
    composerOwned === true &&
    Number.isSafeInteger(attributionWindowMs) &&
    attributionWindowMs > 0 &&
    attributionWindowMs <= SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS
  ) {
    result.recovery = {
      baselineCursor,
      contentHash,
      pressedAt,
      composerOwned,
      attributionWindowMs,
    };
  }
  return result;
}

class IdempotencyStore {
  #entries = new Map();
  #bindings = new Map();

  run(key, sessionId, fingerprint, task) {
    this.#prune();
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const binding = this.#bindings.get(key);
    if (
      binding &&
      (binding.sessionId !== sessionId ||
        binding.fingerprint !== fingerprint)
    ) {
      throw new HttpError(409, 'idempotency_key_reused');
    }
    if (!binding) {
      this.#bindings.set(key, {
        sessionId,
        fingerprint,
        expiresAt,
      });
    } else {
      binding.expiresAt = expiresAt;
    }
    const existing = this.#entries.get(key);
    if (existing) {
      if (
        existing.sessionId !== sessionId ||
        existing.fingerprint !== fingerprint
      ) {
        throw new HttpError(409, 'idempotency_key_reused');
      }
      return existing.promise;
    }
    const promise = Promise.resolve().then(task);
    const entry = {
      sessionId,
      fingerprint,
      promise,
      state: 'pending',
      result: null,
      reconciliationPromise: null,
      expiresAt,
    };
    this.#entries.set(key, entry);
    void promise.then(
      (result) => {
        entry.state = 'resolved';
        entry.result = result;
        if (result?.ok !== false || result.safeToRetry !== true) return;
        const current = this.#entries.get(key);
        if (current?.promise === promise) this.#entries.delete(key);
      },
      () => {
        entry.state = 'rejected';
        // Unknown failures remain cached because the send outcome may be ambiguous.
      },
    );
    return promise;
  }

  async status(key, sessionId, database) {
    this.#prune();
    const entry = this.#entries.get(key);
    if (!entry || entry.sessionId !== sessionId) {
      return { state: 'unknown' };
    }
    if (entry.state === 'pending') return { state: 'pending' };
    if (entry.state !== 'resolved' || !entry.result) {
      return { state: 'unknown' };
    }
    const recovery = entry.result.recovery;
    if (
      !entry.result.ok &&
      entry.result.code === 'send_not_confirmed' &&
      recovery &&
      Number.isSafeInteger(recovery.baselineCursor) &&
      recovery.baselineCursor >= 0 &&
      typeof recovery.contentHash === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(recovery.contentHash) &&
      Number.isSafeInteger(recovery.pressedAt) &&
      recovery.pressedAt > 0 &&
      recovery.composerOwned === true &&
      Number.isSafeInteger(recovery.attributionWindowMs) &&
      recovery.attributionWindowMs > 0 &&
      recovery.attributionWindowMs <=
        SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS
    ) {
      if (!entry.reconciliationPromise) {
        entry.reconciliationPromise = reconcileExactUserMessage({
          database,
          sessionId,
          afterRowId: recovery.baselineCursor,
          exactContentHash: recovery.contentHash,
          pressedAt: recovery.pressedAt,
          composerOwned: recovery.composerOwned,
          attributionWindowMs: recovery.attributionWindowMs,
        })
          .then((reconciliation) => {
            if (
              reconciliation.state === 'delivered' &&
              !entry.result.ok
            ) {
              const delivered = databaseDeliveryResult(
                reconciliation.match,
                recovery.baselineCursor,
              );
              entry.result = delivered;
              entry.promise = Promise.resolve(delivered);
            }
            return reconciliation.state;
          })
          .finally(() => {
            entry.reconciliationPromise = null;
          });
      }
      const reconciliationState = await entry.reconciliationPromise;
      if (reconciliationState === 'pending') return { state: 'pending' };
    }
    if (entry.result.ok) {
      return {
        state: 'delivered',
        deliveredAt: entry.result.deliveredAt,
        baselineCursor: entry.result.baselineCursor,
        messageId: entry.result.messageId || null,
        rowId: entry.result.rowId || null,
      };
    }
    return {
      state: 'failed',
      code: entry.result.code,
      retrySafe: entry.result.safeToRetry === true,
    };
  }

  #prune() {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
    for (const [key, binding] of this.#bindings) {
      if (binding.expiresAt <= now) this.#bindings.delete(key);
    }
  }
}

function sendFingerprint({
  message,
  replaceDraft,
  expectedMacDraft,
}) {
  return sha256(
    JSON.stringify([message, replaceDraft, expectedMacDraft]),
  );
}

class ConnectionProbe {
  #transport;
  #result;
  #expiresAt = 0;

  constructor(transport) {
    this.#transport = transport;
  }

  async run({ force = false } = {}) {
    if (!force && this.#result && this.#expiresAt > Date.now()) return this.#result;
    const result = await this.#transport.doctor();
    this.#result = {
      checkedAt: new Date().toISOString(),
      relayVersion: APP_VERSION,
      conductor: result.ok,
      sendPath: result.ok,
      reason: result.ok ? null : result.code,
      capabilities: {
        read: true,
        send: result.ok,
        devices: true,
        passkey: true,
        stop: false,
        newChat: false,
        openConductor: false,
        readMacDraft: false,
      },
    };
    this.#expiresAt = Date.now() + 10_000;
    return this.#result;
  }
}

export function createPocketServer({
  configStore,
  security,
  database,
  watcher,
  transport,
}) {
  const idempotency = new IdempotencyStore();
  const probe = new ConnectionProbe(transport);
  const clients = new Set();
  let sendQueue = Promise.resolve();

  function serializeSend(task) {
    const pending = sendQueue.then(task, task);
    sendQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  const unsubscribe = watcher.subscribe((event) => {
    const payload = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  });

  const server = http.createServer(async (request, response) => {
    const config = configStore.value;
    try {
      const requestUrl = new URL(request.url || '/', config.publicOrigin);
      assertHost(request, config);

      if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
        return sendJson(
          response,
          200,
          {
            ok: true,
            app: APP_NAME,
            version: APP_VERSION,
            configRevision: configRevision(config),
          },
          config,
        );
      }

      if (
        request.method === 'POST' &&
        requestUrl.pathname === '/api/pair/start'
      ) {
        const body = await readJson(request);
        const result = await security.startPairing(request, body);
        return sendJson(
          response,
          200,
          {
            options: result.options,
            verificationCode: getVerificationCode(config),
            macName: config.macName || 'Your Mac',
            hostname: config.rpId,
          },
          config,
          { 'Set-Cookie': result.setCookie },
        );
      }

      if (
        request.method === 'POST' &&
        requestUrl.pathname === '/api/pair/finish'
      ) {
        const body = await readJson(request);
        const result = await security.finishPairing(request, body.response);
        return sendJson(
          response,
          200,
          {
            authenticated: true,
            unlocked: true,
            device: result.device,
            csrfToken: result.csrfToken,
          },
          config,
          { 'Set-Cookie': result.setCookies },
        );
      }

      if (
        request.method === 'GET' &&
        requestUrl.pathname === '/api/auth/bootstrap'
      ) {
        const result = security.bootstrap(request);
        return sendJson(response, 200, result, config);
      }

      if (
        request.method === 'POST' &&
        requestUrl.pathname === '/api/auth/options'
      ) {
        const options = await security.authenticationOptions(request);
        return sendJson(response, 200, options, config);
      }

      if (
        request.method === 'POST' &&
        requestUrl.pathname === '/api/auth/verify'
      ) {
        const body = await readJson(request);
        const result = await security.verifyAuthentication(request, body.response);
        return sendJson(response, 200, result, config);
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/auth/lock') {
        const result = security.lock(request);
        return sendJson(response, 200, result, config);
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/auth/touch') {
        const result = security.touch(request);
        return sendJson(response, 200, result, config);
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/events') {
        security.session(request, { requireUnlocked: true });
        response.writeHead(200, {
          ...securityHeaders(config, { api: true }),
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write(
          `event: ready\ndata: ${JSON.stringify({
            type: 'ready',
            at: new Date().toISOString(),
          })}\n\n`,
        );
        clients.add(response);
        const heartbeat = setInterval(() => {
          try {
            security.session(request, {
              requireUnlocked: true,
              touch: false,
            });
            response.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
          } catch (error) {
            response.write(
              `event: locked\ndata: ${JSON.stringify({
                code: asHttpError(error).code,
              })}\n\n`,
            );
            response.end();
          }
        }, SSE_HEARTBEAT_MS);
        heartbeat.unref();
        request.on('close', () => {
          clearInterval(heartbeat);
          clients.delete(response);
        });
        return;
      }

      if (
        request.method === 'GET' &&
        requestUrl.pathname === '/api/connection'
      ) {
        security.session(request, { requireUnlocked: true });
        const result = await probe.run({ force: requestUrl.searchParams.has('force') });
        return sendJson(response, 200, result, config);
      }

      if (
        request.method === 'GET' &&
        requestUrl.pathname === '/api/workspaces'
      ) {
        security.session(request, { requireUnlocked: true });
        return sendJson(
          response,
          200,
          { workspaces: database.listWorkspaces() },
          config,
        );
      }

      if (
        request.method === 'GET' &&
        requestUrl.pathname === '/api/sessions/recent'
      ) {
        security.session(request, { requireUnlocked: true });
        return sendJson(
          response,
          200,
          {
            sessions: database.listRecentSessions(
              requestUrl.searchParams.get('limit') || 50,
            ),
          },
          config,
        );
      }

      const workspaceSessions = pathMatch(
        requestUrl.pathname,
        /^\/api\/workspaces\/([^/]+)\/sessions$/,
      );
      if (request.method === 'GET' && workspaceSessions) {
        security.session(request, { requireUnlocked: true });
        return sendJson(
          response,
          200,
          { sessions: database.listSessions(workspaceSessions[0]) },
          config,
        );
      }

      const sessionMessages = pathMatch(
        requestUrl.pathname,
        /^\/api\/sessions\/([^/]+)\/messages$/,
      );
      const deliveryStatus = pathMatch(
        requestUrl.pathname,
        /^\/api\/sessions\/([^/]+)\/delivery-status$/,
      );
      if (request.method === 'POST' && deliveryStatus) {
        security.assertOrigin(request);
        const auth = security.session(request, {
          requireUnlocked: true,
          requireCsrf: true,
        });
        const route = database.getSessionRoute(deliveryStatus[0]);
        if (!route) throw new HttpError(404, 'session_not_found');
        const key = `${auth.device.id}:${idempotencyKey(request)}`;
        return sendJson(
          response,
          200,
          { delivery: await idempotency.status(key, route.id, database) },
          config,
        );
      }
      if (request.method === 'GET' && sessionMessages) {
        security.session(request, { requireUnlocked: true });
        const result = database.listMessages(sessionMessages[0], {
          after: requestUrl.searchParams.get('after') || 0,
          limit: requestUrl.searchParams.get('limit') || 500,
        });
        if (!result) throw new HttpError(404, 'session_not_found');
        return sendJson(response, 200, result, config);
      }

      if (request.method === 'POST' && sessionMessages) {
        security.assertOrigin(request);
        const auth = security.session(request, {
          requireUnlocked: true,
          requireCsrf: true,
        });
        const body = await readJson(request);
        const route = database.getSessionRoute(sessionMessages[0]);
        if (!route) throw new HttpError(404, 'session_not_found');
        const key = `${auth.device.id}:${idempotencyKey(request)}`;
        const normalizedMessage = normalizeText(body.message);
        const replaceDraft = body.replaceDraft === true;
        const expectedMacDraft =
          typeof body.expectedMacDraft === 'string'
            ? normalizeText(body.expectedMacDraft)
            : null;
        const fingerprint = sendFingerprint({
          message: normalizedMessage,
          replaceDraft,
          expectedMacDraft,
        });
        const result = await idempotency.run(
          key,
          route.id,
          fingerprint,
          () =>
            serializeSend(async () => {
              const beforeRowId = database.getSessionMessageCursor(route.id);
              const sendResult = await transport.send({
                workspaceName: route.workspaceName,
                sessionTitle: route.title,
                sessionOrdinal: route.titleOrdinal,
                message: normalizedMessage,
                replaceDraft,
                expectedMacDraft,
              });
              if (
                !sendResult.ok &&
                sendResult.code !== 'send_not_confirmed' &&
                sendResult.code !== 'send_interrupted'
              ) {
                return sendResult;
              }
              const confirmed = await waitForExactUserMessage({
                database,
                sessionId: route.id,
                afterRowId: beforeRowId,
                exactContent: normalizedMessage,
                pressedAt: sendResult.pressedAt,
                composerOwned: sendResult.composerOwned,
                timeoutMs:
                  sendResult.code === 'send_interrupted'
                    ? SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS
                    : SEND_CONFIRMATION_TIMEOUT_MS,
                attributionWindowMs:
                  sendResult.code === 'send_interrupted'
                    ? SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS
                    : SEND_ATTRIBUTION_WINDOW_MS,
              });
              if (!confirmed) {
                if (sendResult.code === 'send_interrupted') {
                  try {
                    const rows = database.listUserMessagesAfter(
                      route.id,
                      beforeRowId,
                    );
                    if (rows.length === 0) {
                      return {
                        ok: false,
                        code: 'user_input_active',
                        safeToRetry: true,
                      };
                    }
                  } catch {
                    // Any unreadable or interfering row keeps the result ambiguous.
                  }
                  return {
                    ...sendNotConfirmedResult({
                      baselineCursor: beforeRowId,
                      contentHash: sha256(normalizedMessage),
                      pressedAt: sendResult.pressedAt,
                      composerOwned: sendResult.composerOwned,
                      attributionWindowMs:
                        SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS,
                    }),
                  };
                }
                if (!sendResult.ok) {
                  return sendNotConfirmedResult({
                    baselineCursor: beforeRowId,
                    contentHash: sha256(normalizedMessage),
                    pressedAt: sendResult.pressedAt,
                    composerOwned: sendResult.composerOwned,
                  });
                }
                return sendNotConfirmedResult({
                  baselineCursor: beforeRowId,
                  contentHash: sha256(normalizedMessage),
                  pressedAt: sendResult.pressedAt,
                  composerOwned: sendResult.composerOwned,
                });
              }
              return databaseDeliveryResult(confirmed, beforeRowId);
            }),
        );
        if (!result.ok) {
          if (result.code === 'draft_conflict') {
            const draft = typeof result.draftBase64 === 'string'
              ? Buffer.from(result.draftBase64, 'base64').toString('utf8')
              : null;
            return sendJson(
              response,
              409,
              { error: { code: result.code, draft } },
              config,
            );
          }
          return sendJson(
            response,
            errorStatuses.get(result.code) || 502,
            {
              error: {
                code: result.code,
                retrySafe: result.safeToRetry === true,
              },
            },
            config,
          );
        }
        return sendJson(
          response,
          200,
          {
            delivery: 'delivered',
            deliveredAt: result.deliveredAt,
            sessionId: route.id,
            confirmation: result.confirmation || 'accessibility',
            baselineCursor: result.baselineCursor,
            messageId: result.messageId || null,
            rowId: result.rowId || null,
          },
          config,
        );
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/devices') {
        const devices = security.listDevices(request);
        return sendJson(response, 200, { devices }, config);
      }

      const revokeDevice = pathMatch(
        requestUrl.pathname,
        /^\/api\/devices\/([^/]+)\/revoke$/,
      );
      if (request.method === 'POST' && revokeDevice) {
        const body = await readJson(request);
        const result = await security.revokeDevice(
          request,
          revokeDevice[0],
          {
            clientVersion: body.clientVersion,
            localPurgeCompleted: body.localPurgeCompleted,
          },
        );
        return sendJson(
          response,
          200,
          { revoked: true, currentDevice: result.currentDevice },
          config,
          result.setCookie ? { 'Set-Cookie': result.setCookie } : {},
        );
      }

      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        staticFiles.has(requestUrl.pathname)
      ) {
        return serveStatic(request, response, requestUrl.pathname, config, {
          head: request.method === 'HEAD',
        });
      }

      throw new HttpError(404, 'not_found');
    } catch (error) {
      const handled = asHttpError(error);
      if (response.headersSent) {
        response.end();
        return;
      }
      sendJson(
        response,
        handled.status,
        { error: { code: handled.code } },
        configStore.value,
      );
    }
  });

  server.on('close', () => {
    unsubscribe();
    watcher.stop();
    for (const client of clients) client.end();
    clients.clear();
  });

  return server;
}

function assertHost(request, config) {
  const host = request.headers.host;
  if (typeof host !== 'string') throw new HttpError(400, 'host_required');
  const allowed = new Set([
    config.rpId,
    `${config.rpId}:443`,
    `${config.bindHost}:${config.port}`,
    `localhost:${config.port}`,
  ]);
  if (!allowed.has(host.toLowerCase())) {
    throw new HttpError(403, 'host_denied');
  }
}

function acceptsBrotli(request) {
  const header = request.headers['accept-encoding'];
  if (typeof header !== 'string') return false;
  return header.split(',').some((entry) => {
    const [name, ...parameters] = entry.split(';');
    if (name.trim().toLowerCase() !== 'br') return false;
    return !parameters.some((parameter) => {
      const [key, value] = parameter.split('=');
      return key.trim().toLowerCase() === 'q' && Number(value) === 0;
    });
  });
}

function loadStaticAsset(filename) {
  if (!staticAssetCache.has(filename)) {
    staticAssetCache.set(
      filename,
      fs.readFile(path.join(publicDirectory, filename)).then(async (body) => {
        let brotli = null;
        if (body.length >= 1024) {
          try {
            brotli = await brotliCompressAsync(body, {
              params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
              },
            });
          } catch {
            // Compression is optional. The identity representation stays live.
          }
        }
        return { body, brotli };
      }),
    );
  }
  return staticAssetCache.get(filename);
}

async function serveStatic(
  request,
  response,
  pathname,
  config,
  { head = false } = {},
) {
  const [filename, contentType] = staticFiles.get(pathname);
  try {
    const asset = await loadStaticAsset(filename);
    const useBrotli = acceptsBrotli(request) && asset.brotli;
    const body = useBrotli ? asset.brotli : asset.body;
    const headers = {
      ...securityHeaders(config),
      'Content-Type': contentType,
      'Content-Length': body.length,
      Vary: 'Accept-Encoding',
      'Cache-Control':
        pathname === '/service-worker.js' ||
        pathname === '/app.js' ||
        pathname === '/delivery-receipts.js' ||
        pathname === '/' ||
        pathname === '/index.html'
          ? 'no-cache'
          : 'public, max-age=3600',
    };
    if (useBrotli) headers['Content-Encoding'] = 'br';
    response.writeHead(200, headers);
    response.end(head ? undefined : body);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(404, 'asset_not_found');
    throw error;
  }
}
