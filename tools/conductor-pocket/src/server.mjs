import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_NAME,
  APP_VERSION,
  MAX_JSON_BODY_BYTES,
  SSE_HEARTBEAT_MS,
} from './constants.mjs';
import { getVerificationCode } from './config.mjs';
import { HttpError, asHttpError } from './errors.mjs';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
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
  ['send_unavailable', 503],
  ['send_failed', 502],
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

class IdempotencyStore {
  #entries = new Map();

  run(key, sessionId, task) {
    this.#prune();
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new HttpError(409, 'idempotency_key_reused');
      }
      return existing.promise;
    }
    const promise = Promise.resolve().then(task);
    this.#entries.set(key, {
      sessionId,
      promise,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    return promise;
  }

  #prune() {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
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
          { ok: true, app: APP_NAME, version: APP_VERSION },
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
        const result = await idempotency.run(key, route.id, () =>
          transport.send({
            workspaceName: route.workspaceName,
            sessionTitle: route.title,
            sessionOrdinal: route.titleOrdinal,
            message: body.message,
            replaceDraft: body.replaceDraft === true,
            expectedMacDraft: body.expectedMacDraft,
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
          throw new HttpError(
            errorStatuses.get(result.code) || 502,
            result.code,
          );
        }
        return sendJson(
          response,
          200,
          {
            delivery: 'delivered',
            deliveredAt: new Date().toISOString(),
            sessionId: route.id,
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
        const result = await security.revokeDevice(request, revokeDevice[0]);
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
        return serveStatic(response, requestUrl.pathname, config, {
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

async function serveStatic(response, pathname, config, { head = false } = {}) {
  const [filename, contentType] = staticFiles.get(pathname);
  try {
    const body = await fs.readFile(path.join(publicDirectory, filename));
    response.writeHead(200, {
      ...securityHeaders(config),
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control':
        pathname === '/service-worker.js' || pathname === '/' || pathname === '/index.html'
          ? 'no-cache'
          : 'public, max-age=3600',
    });
    response.end(head ? undefined : body);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(404, 'asset_not_found');
    throw error;
  }
}
