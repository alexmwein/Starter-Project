import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  lstatSync,
  readFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  brotliCompress,
  brotliCompressSync,
  constants as zlibConstants,
} from 'node:zlib';
import {
  APP_NAME,
  APP_VERSION,
  MAX_JSON_BODY_BYTES,
  MAX_MESSAGE_BYTES,
  SHELL_REVISION,
  SSE_HEARTBEAT_MS,
} from './constants.mjs';
import {
  AttachmentManager,
  readImageUpload,
} from './attachments.mjs';
import {
  composeAttachmentMessage,
  hasAttachmentMentionSyntax,
} from './attachment-markup.mjs';
import { configRevision, getVerificationCode } from './config.mjs';
import { normalizeText, sha256 } from './encoding.mjs';
import { HttpError, asHttpError } from './errors.mjs';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const SEND_CONFIRMATION_TIMEOUT_MS = 5_000;
const SEND_CONFIRMATION_POLL_MS = 50;
const SEND_ATTRIBUTION_WINDOW_MS = 3_000;
const SEND_EVENT_TIMESTAMP_SKEW_MS = 250;
const SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS = 60_000;
const SEND_ATTRIBUTION_RECHECK_MS = 400;
const SEND_DELIVERY_RECOVERY_ATTRIBUTION_WINDOW_MS = 15_000;
const SEND_DELIVERY_RECOVERY_TIMEOUT_MS = 1_000;
const SEND_AUTOMATION_RETRY_BUDGET_MS = 45_000;
const DELIVERY_PHASES = new Set(['queued', 'automating', 'confirming']);
const DELIVERY_LEDGER_VERSION = 1;
const DELIVERY_LEDGER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_LEDGER_MAX_ENTRIES = 2048;
const DELIVERY_LEDGER_MAX_BYTES = 4 * 1024 * 1024;
const TRANSIENT_PRE_COMPOSER_CODES = new Set([
  'workspace_list_unavailable',
  'workspace_not_visible',
  'session_not_visible',
  'composer_unavailable',
]);
const PHYSICAL_INPUT_COUNTER_COUNT = 16;
const brotliCompressAsync = promisify(brotliCompress);
const staticAssetCache = new Map();

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  [
    '/bootstrap-recovery.js',
    ['bootstrap-recovery.js', 'text/javascript; charset=utf-8'],
  ],
  [
    '/delivery-receipts.js',
    ['delivery-receipts.js', 'text/javascript; charset=utf-8'],
  ],
  [
    '/draft-conflict.js',
    ['draft-conflict.js', 'text/javascript; charset=utf-8'],
  ],
  ['/app-update.js', ['app-update.js', 'text/javascript; charset=utf-8']],
  ['/http.js', ['http.js', 'text/javascript; charset=utf-8']],
  [
    '/image-attachments.js',
    ['image-attachments.js', 'text/javascript; charset=utf-8'],
  ],
  [
    '/live-refresh.js',
    ['live-refresh.js', 'text/javascript; charset=utf-8'],
  ],
  ['/rich-text.js', ['rich-text.js', 'text/javascript; charset=utf-8']],
  ['/read-state.js', ['read-state.js', 'text/javascript; charset=utf-8']],
  [
    '/transcript-focus.js',
    ['transcript-focus.js', 'text/javascript; charset=utf-8'],
  ],
  [
    '/swipe-navigation.js',
    ['swipe-navigation.js', 'text/javascript; charset=utf-8'],
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
  ['composer_changed_pre_send', 502],
  ['composer_update_failed', 502],
  ['conductor_not_running', 503],
  ['conductor_window_unavailable', 503],
  ['accessibility_disabled', 503],
  ['input_helper_unavailable', 503],
  ['session_locked', 503],
  ['send_unavailable', 503],
  ['send_failed', 502],
  ['user_input_active', 409],
  ['send_not_confirmed', 502],
  ['automation_timeout', 504],
  ['automation_failed', 502],
  ['automation_invalid_response', 502],
  ['session_route_changed', 409],
]);

function securityHeaders(config, { api = false } = {}) {
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' blob: data:",
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
  let body = Buffer.from(JSON.stringify(value));
  const compressed =
    body.length >= 1024 &&
    acceptsBrotli(response.req);
  if (compressed) {
    body = brotliCompressSync(body, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      },
    });
  }
  response.writeHead(status, {
    ...securityHeaders(config, { api: true }),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...(compressed
      ? {
          'Content-Encoding': 'br',
          Vary: 'Accept-Encoding',
        }
      : {}),
    ...extraHeaders,
  });
  response.end(body);
}

function sendImage(response, image, config, { head = false } = {}) {
  response.writeHead(200, {
    ...securityHeaders(config, { api: true }),
    'Content-Type': image.contentType,
    'Content-Length': image.body.length,
    'Content-Disposition': 'inline; filename="image.jpg"',
  });
  response.end(head ? undefined : image.body);
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

function clientShellRevision(request) {
  const value = request.headers['x-pocket-shell-revision'];
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 100 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  )
    ? value
    : null;
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
  exactContentProof,
  proofSecret,
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
        !/^[A-Za-z0-9_-]{43}$/.test(exactContentHash)) &&
      (typeof exactContentProof !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(exactContentProof) ||
        typeof proofSecret !== 'string' ||
        proofSecret.length < 32))
  ) {
    return null;
  }
  const contentMatches = (message) =>
    typeof message?.text === 'string' &&
    (typeof exactContent === 'string'
      ? message.text === exactContent
      : typeof exactContentHash === 'string'
        ? sha256(message.text) === exactContentHash
        : deliveryLedgerProofMatches(
            deliveryLedgerProof(
              proofSecret,
              'message-content-hash',
              sha256(message.text),
            ),
            exactContentProof,
          ));
  const earliestCreatedAt = pressedAt - SEND_EVENT_TIMESTAMP_SKEW_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let candidateIdentity = null;
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
          createdAt < earliestCreatedAt ||
          createdAt > pressedAt + attributionWindowMs
        ) {
          return null;
        }
        if (
          candidateIdentity &&
          (match.id !== candidateIdentity.id ||
            match.rowId !== candidateIdentity.rowId)
        ) {
          return null;
        }
        candidateIdentity ||= { id: match.id, rowId: match.rowId };
        await delay(Math.max(0, recheckMs));
        const rechecked = database.listUserMessagesAfter(
          sessionId,
          afterRowId,
        );
        if (rechecked.length === 0) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return null;
          await delay(Math.min(Math.max(1, pollMs), remaining));
          continue;
        }
        const recheckedMatch = rechecked[0];
        const recheckedCreatedAt = Date.parse(recheckedMatch?.createdAt);
        if (
          rechecked.length === 1 &&
          recheckedMatch.id === match.id &&
          recheckedMatch.rowId === match.rowId &&
          contentMatches(recheckedMatch) &&
          Number.isFinite(recheckedCreatedAt) &&
          recheckedCreatedAt >= earliestCreatedAt &&
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
  exactContentProof,
  proofSecret,
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
      exactContentProof,
      proofSecret,
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
  code = 'send_not_confirmed',
  baselineCursor,
  contentHash,
  pressedAt,
  composerOwned,
  attributionWindowMs = SEND_DELIVERY_RECOVERY_ATTRIBUTION_WINDOW_MS,
}) {
  const result = {
    ok: false,
    code,
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

function deliveryLedgerProof(secret, domain, value) {
  return createHmac('sha256', secret)
    .update(`${domain}\0${value}`, 'utf8')
    .digest('base64url');
}

function deliveryLedgerProofMatches(left, right) {
  if (
    typeof left !== 'string' ||
    typeof right !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(left) ||
    !/^[A-Za-z0-9_-]{43}$/.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function durableDeliveryResult(result, secret) {
  if (!result || typeof result.ok !== 'boolean') return null;
  if (result.ok) {
    return {
      ok: true,
      code: 'sent',
      deliveredAt:
        typeof result.deliveredAt === 'string'
          ? result.deliveredAt
          : new Date().toISOString(),
      baselineCursor: Number.isSafeInteger(result.baselineCursor)
        ? result.baselineCursor
        : null,
      rowId: Number.isSafeInteger(result.rowId) ? result.rowId : null,
    };
  }
  const durable = {
    ok: false,
    code:
      typeof result.code === 'string' &&
      /^[a-z0-9_]{1,80}$/.test(result.code)
        ? result.code
        : 'internal_error',
    safeToRetry: result.safeToRetry === true,
  };
  const recovery = result.recovery;
  if (
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
    recovery.attributionWindowMs <= SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS
  ) {
    durable.recovery = {
      baselineCursor: recovery.baselineCursor,
      contentProof: deliveryLedgerProof(
        secret,
        'message-content-hash',
        recovery.contentHash,
      ),
      pressedAt: recovery.pressedAt,
      composerOwned: true,
      attributionWindowMs: recovery.attributionWindowMs,
    };
  }
  return durable;
}

function validateDurableDeliveryResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }
  if (result.ok === true) {
    if (
      result.code !== 'sent' ||
      typeof result.deliveredAt !== 'string' ||
      !Number.isFinite(Date.parse(result.deliveredAt)) ||
      !(
        result.baselineCursor === null ||
        (Number.isSafeInteger(result.baselineCursor) &&
          result.baselineCursor >= 0)
      ) ||
      !(
        result.rowId === null ||
        (Number.isSafeInteger(result.rowId) && result.rowId >= 0)
      )
    ) {
      return null;
    }
    return {
      ok: true,
      code: 'sent',
      deliveredAt: result.deliveredAt,
      baselineCursor: result.baselineCursor,
      rowId: result.rowId,
    };
  }
  if (
    result.ok !== false ||
    typeof result.code !== 'string' ||
    !/^[a-z0-9_]{1,80}$/.test(result.code) ||
    typeof result.safeToRetry !== 'boolean'
  ) {
    return null;
  }
  const validated = {
    ok: false,
    code: result.code,
    safeToRetry: result.safeToRetry,
  };
  if (result.recovery !== undefined) {
    const recovery = result.recovery;
    if (
      !recovery ||
      typeof recovery !== 'object' ||
      Array.isArray(recovery) ||
      Number.isSafeInteger(recovery.baselineCursor) === false ||
      recovery.baselineCursor < 0 ||
      typeof recovery.contentProof !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(recovery.contentProof) ||
      !Number.isSafeInteger(recovery.pressedAt) ||
      recovery.pressedAt <= 0 ||
      recovery.composerOwned !== true ||
      !Number.isSafeInteger(recovery.attributionWindowMs) ||
      recovery.attributionWindowMs <= 0 ||
      recovery.attributionWindowMs >
        SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS
    ) {
      return null;
    }
    validated.recovery = {
      baselineCursor: recovery.baselineCursor,
      contentProof: recovery.contentProof,
      pressedAt: recovery.pressedAt,
      composerOwned: true,
      attributionWindowMs: recovery.attributionWindowMs,
    };
  }
  return validated;
}

class IdempotencyStore {
  #entries = new Map();
  #bindings = new Map();
  #ledgerPath;
  #secret;
  #persistQueue = Promise.resolve();

  constructor({ ledgerPath = null, secret }) {
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new Error('Delivery ledger secret is unavailable');
    }
    if (
      ledgerPath !== null &&
      (typeof ledgerPath !== 'string' || !path.isAbsolute(ledgerPath))
    ) {
      throw new Error('Delivery ledger path must be absolute');
    }
    this.#ledgerPath = ledgerPath;
    this.#secret = secret;
    this.#load();
  }

  run(key, sessionId, fingerprint, task) {
    this.#prune();
    const entryKey = this.#keyProof(key);
    const sessionProof = this.#sessionProof(sessionId);
    const fingerprintProof = this.#fingerprintProof(fingerprint);
    const expiresAt = Date.now() + DELIVERY_LEDGER_TTL_MS;
    const binding = this.#bindings.get(entryKey);
    if (
      binding &&
      (!deliveryLedgerProofMatches(binding.sessionProof, sessionProof) ||
        !deliveryLedgerProofMatches(
          binding.fingerprintProof,
          fingerprintProof,
        ))
    ) {
      throw new HttpError(409, 'idempotency_key_reused');
    }
    let existing = this.#entries.get(entryKey);
    if (existing) {
      if (
        !deliveryLedgerProofMatches(existing.sessionProof, sessionProof) ||
        !deliveryLedgerProofMatches(
          existing.fingerprintProof,
          fingerprintProof,
        )
      ) {
        throw new HttpError(409, 'idempotency_key_reused');
      }
      if (
        existing.state !== 'resolved' ||
        existing.result?.ok !== false ||
        existing.result.safeToRetry !== true
      ) {
        existing.expiresAt = expiresAt;
        binding.expiresAt = expiresAt;
        void this.#persist().catch(() => {});
        return { promise: existing.promise, joined: true };
      }
      // A retained safe-to-retry tombstone remains queryable until the phone
      // explicitly retries the same idempotency key. That retry replaces it
      // with one bounded pending operation.
      this.#entries.delete(entryKey);
      existing = null;
    }
    this.#makeRoomFor(entryKey);
    if (!binding) {
      this.#bindings.set(entryKey, {
        sessionProof,
        fingerprintProof,
        expiresAt,
      });
    } else {
      binding.expiresAt = expiresAt;
    }
    const entry = {
      sessionProof,
      fingerprintProof,
      promise: null,
      state: 'pending',
      phase: 'queued',
      result: null,
      reconciliationPromise: null,
      expiresAt,
    };
    const setPhase = (phase) => {
      if (
        entry.state === 'pending' &&
        DELIVERY_PHASES.has(phase)
      ) {
        entry.phase = phase;
        return this.#persist();
      }
      return Promise.resolve();
    };
    // Make the in-flight replacement durable before any transport can touch
    // Conductor. A crash can then never resurrect an older safe-to-retry
    // tombstone and invite a duplicate press.
    this.#entries.set(entryKey, entry);
    const taskPromise = this.#persist().then(() => task(setPhase));
    const promise = taskPromise.then(
      async (result) => {
        entry.state = 'resolved';
        entry.result = result;
        await this.#persist();
        return result;
      },
      async (error) => {
        if (error?.deliveryDefinitelyUnsent === true) {
          const current = this.#entries.get(entryKey);
          if (current === entry) this.#entries.delete(entryKey);
          await this.#persist();
          throw error;
        }
        // A transport exception after the send boundary is ambiguous, but it
        // must still resolve to an authoritative status. Keeping a rejected
        // entry as `unknown` makes every phone recovery poll futile.
        entry.state = 'resolved';
        entry.result = {
          ok: false,
          code: 'internal_error',
        };
        await this.#persist();
        throw error;
      },
    );
    entry.promise = promise;
    return { promise, joined: false };
  }

  async status(key, sessionId, database) {
    if (this.#prune()) await this.#persist();
    const entry = this.#entries.get(this.#keyProof(key));
    if (!entry) {
      // No entry at all is different from an entry we cannot interpret, and
      // conflating them stranded the operator. Every send that never reached
      // this relay (Mac asleep, relay restarting, phone off network) landed
      // here, the phone read "unknown", and it offered neither Retry nor Edit,
      // so the typed text could not be recovered at all.
      //
      // The ledger is durable across relay restarts and only drops entries
      // after its TTL, so within that window an absent key proves the send was
      // never recorded, which means it never ran. The TTL is reported so the
      // caller can check its own message is younger than it rather than
      // trusting absence forever.
      return { state: 'absent', ledgerTtlMs: DELIVERY_LEDGER_TTL_MS };
    }
    if (
      !deliveryLedgerProofMatches(
        entry.sessionProof,
        this.#sessionProof(sessionId),
      )
    ) {
      // The key exists but belongs to another session. Nothing can be proven
      // about this one, so it stays ambiguous.
      return { state: 'unknown' };
    }
    if (entry.state === 'pending') {
      return { state: 'pending', phase: entry.phase || 'queued' };
    }
    if (entry.state !== 'resolved' || !entry.result) {
      return { state: 'unknown' };
    }
    const recovery = entry.result.recovery;
    if ((
      !entry.result.ok &&
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
    ) || (
      !entry.result.ok &&
      recovery &&
      Number.isSafeInteger(recovery.baselineCursor) &&
      recovery.baselineCursor >= 0 &&
      typeof recovery.contentProof === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(recovery.contentProof) &&
      Number.isSafeInteger(recovery.pressedAt) &&
      recovery.pressedAt > 0 &&
      recovery.composerOwned === true &&
      Number.isSafeInteger(recovery.attributionWindowMs) &&
      recovery.attributionWindowMs > 0 &&
      recovery.attributionWindowMs <=
        SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS
    )) {
      if (!entry.reconciliationPromise) {
        entry.reconciliationPromise = reconcileExactUserMessage({
          database,
          sessionId,
          afterRowId: recovery.baselineCursor,
          exactContentHash: recovery.contentHash,
          exactContentProof: recovery.contentProof,
          proofSecret: this.#secret,
          pressedAt: recovery.pressedAt,
          composerOwned: recovery.composerOwned,
          attributionWindowMs: recovery.attributionWindowMs,
        })
          .then(async (reconciliation) => {
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
              await this.#persist();
            }
            return reconciliation.state;
          })
          .finally(() => {
            entry.reconciliationPromise = null;
          });
      }
      const reconciliationState = await entry.reconciliationPromise;
      if (reconciliationState === 'pending') {
        return { state: 'pending', phase: 'confirming' };
      }
      if (reconciliationState === 'failed' && !entry.result.ok) {
        // A failed reconciliation is conclusive: either its attribution
        // window elapsed or another row made attribution unsafe. Do not scan
        // the database again for this idempotency key.
        delete entry.result.recovery;
        await this.#persist();
      }
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
      final: true,
    };
  }

  #prune() {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
        changed = true;
      }
    }
    for (const [key, binding] of this.#bindings) {
      if (binding.expiresAt <= now) {
        this.#bindings.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  #keyProof(key) {
    return deliveryLedgerProof(this.#secret, 'idempotency-key', key);
  }

  #makeRoomFor(entryKey) {
    const reusesBinding = this.#bindings.has(entryKey);
    if (
      this.#entries.has(entryKey) ||
      (this.#entries.size < DELIVERY_LEDGER_MAX_ENTRIES &&
        (reusesBinding ||
          this.#bindings.size < DELIVERY_LEDGER_MAX_ENTRIES))
    ) {
      return;
    }
    const evictable = [...this.#bindings.entries()]
      .filter(
        ([key]) =>
          key !== entryKey &&
          this.#entries.get(key)?.state !== 'pending',
      )
      .sort((left, right) => left[1].expiresAt - right[1].expiresAt);
    for (const [key] of evictable) {
      this.#entries.delete(key);
      this.#bindings.delete(key);
      if (
        this.#entries.size < DELIVERY_LEDGER_MAX_ENTRIES &&
        this.#bindings.size < DELIVERY_LEDGER_MAX_ENTRIES
      ) {
        return;
      }
    }
    throw new HttpError(503, 'delivery_queue_full');
  }

  #sessionProof(sessionId) {
    return deliveryLedgerProof(this.#secret, 'session-id', sessionId);
  }

  #fingerprintProof(fingerprint) {
    return deliveryLedgerProof(
      this.#secret,
      'delivery-fingerprint',
      fingerprint,
    );
  }

  #load() {
    if (!this.#ledgerPath) return;
    let stat;
    try {
      stat = lstatSync(this.#ledgerPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > DELIVERY_LEDGER_MAX_BYTES
    ) {
      throw new Error('Delivery ledger is not a private bounded file');
    }
    const parsed = JSON.parse(readFileSync(this.#ledgerPath, 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed.version !== DELIVERY_LEDGER_VERSION ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.length > DELIVERY_LEDGER_MAX_ENTRIES
    ) {
      throw new Error('Delivery ledger is invalid');
    }
    const now = Date.now();
    for (const record of parsed.entries) {
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        typeof record.keyProof !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(record.keyProof) ||
        typeof record.sessionProof !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(record.sessionProof) ||
        typeof record.fingerprintProof !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(record.fingerprintProof) ||
        !Number.isSafeInteger(record.expiresAt) ||
        record.expiresAt <= now ||
        record.expiresAt > now + DELIVERY_LEDGER_TTL_MS
      ) {
        continue;
      }
      const pending = record.state === 'pending';
      const queuedBeforeTransport = pending && record.phase === 'queued';
      const result = pending
        ? queuedBeforeTransport
          ? {
              ok: false,
              code: 'relay_restarted_before_send',
              safeToRetry: true,
            }
          : {
              ok: false,
              code: 'relay_restarted_during_send',
              safeToRetry: false,
            }
        : validateDurableDeliveryResult(record.result);
      if (!pending && !result) continue;
      if (
        pending &&
        !DELIVERY_PHASES.has(record.phase)
      ) {
        continue;
      }
      const entry = {
        sessionProof: record.sessionProof,
        fingerprintProof: record.fingerprintProof,
        // Queued is durably before the transport boundary and may retry.
        // Automating/confirming crossed that boundary, so a restart is final
        // and non-retryable rather than an endless pending receipt.
        promise: Promise.resolve(result),
        state: 'resolved',
        phase: null,
        result,
        reconciliationPromise: null,
        expiresAt: record.expiresAt,
      };
      this.#entries.set(record.keyProof, entry);
      this.#bindings.set(record.keyProof, {
        sessionProof: record.sessionProof,
        fingerprintProof: record.fingerprintProof,
        expiresAt: record.expiresAt,
      });
    }
  }

  #persist() {
    if (!this.#ledgerPath) return Promise.resolve();
    const write = async () => {
      const now = Date.now();
      const entries = [];
      for (const [keyProof, entry] of this.#entries) {
        if (entry.expiresAt <= now) {
          continue;
        }
        if (entry.state === 'pending') {
          entries.push({
            keyProof,
            sessionProof: entry.sessionProof,
            fingerprintProof: entry.fingerprintProof,
            expiresAt: entry.expiresAt,
            state: 'pending',
            phase: DELIVERY_PHASES.has(entry.phase)
              ? entry.phase
              : 'queued',
            result: null,
          });
          continue;
        }
        if (entry.state !== 'resolved') continue;
        const result = durableDeliveryResult(entry.result, this.#secret);
        if (!result) continue;
        entries.push({
          keyProof,
          sessionProof: entry.sessionProof,
          fingerprintProof: entry.fingerprintProof,
          expiresAt: entry.expiresAt,
          state: 'resolved',
          phase: null,
          result,
        });
      }
      entries.sort((left, right) => right.expiresAt - left.expiresAt);
      const retainedEntries = entries.slice(0, DELIVERY_LEDGER_MAX_ENTRIES);
      const body = `${JSON.stringify({
        version: DELIVERY_LEDGER_VERSION,
        entries: retainedEntries,
      })}\n`;
      if (Buffer.byteLength(body, 'utf8') > DELIVERY_LEDGER_MAX_BYTES) {
        throw new Error('Delivery ledger exceeds its size limit');
      }
      const directory = path.dirname(this.#ledgerPath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryStat = await fs.lstat(directory);
      if (
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        (directoryStat.mode & 0o077) !== 0
      ) {
        throw new Error('Delivery ledger directory is not private');
      }
      const existing = await fs.lstat(this.#ledgerPath).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
        throw new Error('Delivery ledger path is unsafe');
      }
      const temporaryPath = `${this.#ledgerPath}.tmp-${process.pid}-${randomUUID()}`;
      let handle;
      try {
        handle = await fs.open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(body, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporaryPath, this.#ledgerPath);
        await fs.chmod(this.#ledgerPath, 0o600);
        const directoryHandle = await fs.open(directory, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } finally {
        await handle?.close().catch(() => {});
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
      }
    };
    this.#persistQueue = this.#persistQueue.then(write, write);
    return this.#persistQueue;
  }
}

function sendFingerprint({
  message,
  replaceDraft,
  expectedMacDraft,
  attachments = [],
}) {
  return sha256(
    JSON.stringify([
      message,
      replaceDraft,
      expectedMacDraft,
      attachments.map(({ id, digest }) => [id, digest]),
    ]),
  );
}

function attachmentWorkspace(route) {
  if (
    !route ||
    typeof route.workspacePath !== 'string' ||
    !path.isAbsolute(route.workspacePath)
  ) {
    throw new HttpError(503, 'workspace_path_unavailable');
  }
  if (
    route.sandboxProvider != null &&
    String(route.sandboxProvider).trim().toLowerCase() !== 'local'
  ) {
    throw new HttpError(409, 'workspace_sandbox_unsupported');
  }
  return route.workspacePath;
}

function decodeCanonicalBase64(value, maxBytes) {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.length > maxBytes ||
    decoded.toString('base64') !== value
  ) {
    return null;
  }
  return decoded;
}

function parseComposerRetryCertificate(result, message) {
  const encoded = decodeCanonicalBase64(
    result?.retryCertificate,
    MAX_MESSAGE_BYTES * 2,
  );
  if (!encoded) return null;
  let certificate;
  try {
    certificate = JSON.parse(encoded.toString('utf8'));
  } catch {
    return null;
  }
  if (
    !certificate ||
    Array.isArray(certificate) ||
    Object.keys(certificate).sort().join(',') !==
      'draftBase64,inputCounters,kind' ||
    typeof certificate.inputCounters !== 'string' ||
    ![
      'exact-draft-unpressed',
      'partial-draft-unpressed',
    ].includes(certificate.kind)
  ) {
    return null;
  }
  const draftBytes = decodeCanonicalBase64(
    certificate.draftBase64,
    MAX_MESSAGE_BYTES,
  );
  if (!draftBytes) return null;
  const draft = draftBytes.toString('utf8');
  if (
    !draft.isWellFormed() ||
    !Buffer.from(draft, 'utf8').equals(draftBytes) ||
    normalizeText(draft) !== draft ||
    draft.includes('\0') ||
    /[\u0001-\u0009\u000b-\u001f\u007f]/.test(draft) ||
    (certificate.kind === 'exact-draft-unpressed'
      ? draft !== message
      : draft === message || (draft !== '' && !message.startsWith(draft)))
  ) {
    return null;
  }
  const counters = certificate.inputCounters.split(',');
  if (
    counters.length !== PHYSICAL_INPUT_COUNTER_COUNT ||
    counters.some((counter) => !/^(?:0|[1-9][0-9]*)$/.test(counter)) ||
    counters.some((counter) => !Number.isSafeInteger(Number(counter)))
  ) {
    return null;
  }
  return {
    draft,
    inputCounters: counters.join(','),
    kind: certificate.kind,
  };
}

function sameSessionRoute(expected, current, { attachments = false } = {}) {
  if (
    !current ||
    current.id !== expected.id ||
    current.workspaceName !== expected.workspaceName ||
    current.title !== expected.title ||
    current.titleOrdinal !== expected.titleOrdinal
  ) {
    return false;
  }
  if (!attachments) return true;
  try {
    return attachmentWorkspace(current) === attachmentWorkspace(expected);
  } catch {
    return false;
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

// Reads the local VDM seat producer. Everything is whitelisted into a small
// fixed shape: the raw payload carries fingerprints, refresh state and full
// history, none of which the phone needs, and none of which should cross the
// wire just because it happened to be in the response.
//
// Loopback only, short timeout, and every failure degrades to available:false
// rather than throwing. Usage is a convenience readout; it must never be able
// to take down a screen the operator opened to diagnose something else.
const SEAT_USAGE_URL = 'http://127.0.0.1:3333/api/profiles';
const SEAT_USAGE_TIMEOUT_MS = 2_000;
const GPT_ACCOUNT_STORE = path.join(os.homedir(), '.codex-accounts');
const GPT_USAGE_CACHE = path.join(
  os.homedir(),
  'Library',
  'Caches',
  'SwiftBar',
  'codex-usage.json',
);
const GPT_USAGE_STALE_MS = 5 * 60 * 1000;

function seatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  // VDM reports utilization as a 0..1 fraction.
  return Math.min(100, Math.round(number * 100));
}

function seatResetAt(value) {
  const number = Number(value);
  // Seconds since epoch in the producer, milliseconds everywhere here.
  return Number.isSafeInteger(number) && number > 0 ? number * 1000 : null;
}

export async function readSeatUsage(fetchImpl = fetch) {
  let payload;
  try {
    const response = await fetchImpl(SEAT_USAGE_URL, {
      signal: AbortSignal.timeout(SEAT_USAGE_TIMEOUT_MS),
    });
    if (!response.ok) return { available: false, reason: 'producer_error' };
    payload = await response.json();
  } catch {
    return { available: false, reason: 'producer_unreachable' };
  }
  if (!payload || !Array.isArray(payload.profiles)) {
    return { available: false, reason: 'producer_unreadable' };
  }
  const seats = payload.profiles
    .filter((profile) => profile && typeof profile === 'object')
    .map((profile) => {
      const limits = profile.rateLimits || {};
      const fiveHour = limits.fiveH || {};
      const sevenDay = limits.sevenD || {};
      return {
        name: typeof profile.name === 'string' ? profile.name.slice(0, 64) : '',
        label:
          typeof profile.label === 'string' ? profile.label.slice(0, 120) : '',
        active: profile.isActive === true,
        // A seat can be fine on the 5 hour window and exhausted on the weekly
        // one, which is exactly the state that reads as "out of usage" with no
        // explanation, so both are reported rather than one summary number.
        fiveHourPercent: seatPercent(fiveHour.utilization),
        fiveHourBlocked: fiveHour.status === 'rejected',
        fiveHourResetAt: seatResetAt(fiveHour.reset),
        weeklyPercent: seatPercent(sevenDay.utilization),
        weeklyBlocked: sevenDay.status === 'rejected',
        weeklyResetAt: seatResetAt(sevenDay.reset),
        blocked: limits.status === 'rejected',
        dormant: profile.dormant === true,
        expired: profile.expired === true,
      };
    })
    .filter((seat) => seat.name !== '');
  return { available: true, seats, fetchedAt: Date.now() };
}

function gptPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(100, Math.round(number));
}

function gptTimestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number * 1000 : null;
}

async function readOptionalUsageText(filePath, readFileImpl) {
  try {
    return String(await readFileImpl(filePath, 'utf8')).trim();
  } catch {
    return '';
  }
}

// Reads only SwiftBar's usage cache plus account filenames and labels. Pocket
// never opens the account snapshot JSON files, which contain the credentials,
// and never starts a paid API request. SwiftBar remains the single refresh
// owner; this surface is only a fast, read-only view of what it already knows.
export async function readGptUsage({
  accountStore = GPT_ACCOUNT_STORE,
  cachePath = GPT_USAGE_CACHE,
  now = Date.now(),
  readdirImpl = fs.readdir,
  readFileImpl = fs.readFile,
} = {}) {
  let entries;
  try {
    entries = await readdirImpl(accountStore, { withFileTypes: true });
  } catch {
    return {
      id: 'gpt',
      label: 'GPT',
      available: false,
      reason: 'account_store_unreachable',
      accounts: [],
    };
  }

  const [active, cacheText] = await Promise.all([
    readOptionalUsageText(path.join(accountStore, '.active'), readFileImpl),
    readOptionalUsageText(cachePath, readFileImpl),
  ]);
  let cache = {};
  try {
    const parsed = JSON.parse(cacheText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cache = parsed;
  } catch {
    cache = {};
  }
  const samples =
    cache.samples && typeof cache.samples === 'object' && !Array.isArray(cache.samples)
      ? cache.samples
      : {};
  const snapshotNames = entries
    .filter(
      (entry) =>
        entry?.isFile?.() &&
        !entry.name.startsWith('.') &&
        entry.name.endsWith('.json'),
    )
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const accounts = await Promise.all(
    snapshotNames.map(async (name) => {
      const label =
        (await readOptionalUsageText(
          path.join(accountStore, `${name}.label`),
          readFileImpl,
        )) || name;
      const sample =
        samples[name] && typeof samples[name] === 'object' && !Array.isArray(samples[name])
          ? samples[name]
          : null;
      const fetchedAt = gptTimestamp(sample?.fetched_at);
      const weeklyPercent = gptPercent(sample?.used_percent);
      return {
        name: name.slice(0, 64),
        label: label.slice(0, 120),
        active: name === active,
        fiveHourPercent: null,
        fiveHourBlocked: false,
        fiveHourResetAt: null,
        weeklyPercent,
        weeklyBlocked: weeklyPercent === 100,
        weeklyResetAt: gptTimestamp(sample?.resets_at),
        blocked: weeklyPercent === 100,
        stale:
          fetchedAt === null ||
          now < fetchedAt ||
          now - fetchedAt > GPT_USAGE_STALE_MS,
        fetchedAt,
      };
    }),
  );
  return {
    id: 'gpt',
    label: 'GPT',
    available: accounts.length > 0,
    reason:
      accounts.length > 0
        ? null
        : cacheText
          ? 'no_accounts'
          : 'usage_cache_unavailable',
    accounts,
  };
}

export async function readAccountUsage({
  readClaude = readSeatUsage,
  readGpt = readGptUsage,
  now = Date.now(),
} = {}) {
  const [claudeResult, gptResult] = await Promise.allSettled([
    readClaude(),
    readGpt(),
  ]);
  const claude =
    claudeResult.status === 'fulfilled'
      ? claudeResult.value
      : { available: false, reason: 'producer_unreachable', seats: [] };
  const gpt =
    gptResult.status === 'fulfilled'
      ? gptResult.value
      : {
          id: 'gpt',
          label: 'GPT',
          available: false,
          reason: 'producer_unreachable',
          accounts: [],
        };
  const providers = [
    {
      id: 'claude',
      label: 'Claude',
      available: claude?.available === true,
      reason: typeof claude?.reason === 'string' ? claude.reason : null,
      accounts: Array.isArray(claude?.seats) ? claude.seats : [],
    },
    {
      id: 'gpt',
      label: 'GPT',
      available: gpt?.available === true,
      reason: typeof gpt?.reason === 'string' ? gpt.reason : null,
      accounts: Array.isArray(gpt?.accounts) ? gpt.accounts : [],
    },
  ];
  return {
    available: providers.some((provider) => provider.available),
    providers,
    fetchedAt: now,
  };
}

export function createPocketServer({
  configStore,
  security,
  database,
  watcher,
  transport,
  audit = () => {},
  attachmentManager = new AttachmentManager(),
  deliveryLedgerPath = null,
  usageReader = readAccountUsage,
}) {
  const idempotency = new IdempotencyStore({
    ledgerPath: deliveryLedgerPath,
    secret: configStore.value.csrfSecret,
  });
  const probe = new ConnectionProbe(transport);
  const clients = new Set();
  let sendQueue = Promise.resolve();

  function recordAudit(event) {
    try {
      audit({
        component: 'conductor-pocket-send',
        at: new Date().toISOString(),
        ...event,
      });
    } catch {
      // Diagnostics must never change delivery behavior.
    }
  }

  function serializeSend(task) {
    const pending = sendQueue.then(task, task);
    sendQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  function localAttachmentWorkspacePaths() {
    try {
      const values = database.listLocalWorkspacePaths?.();
      return Array.isArray(values) ? values : [];
    } catch {
      return [];
    }
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
  queueMicrotask(() => {
    void attachmentManager
      .sweepWorkspaces?.(localAttachmentWorkspacePaths())
      ?.catch?.(() => {
        recordAudit({ phase: 'attachment-sweep-failed' });
      });
  });

  const server = http.createServer(async (request, response) => {
    const config = configStore.value;
    let requestPathname = null;
    let deliveryTransportStarted = false;
    let deliveryDefinitelyUnsent = false;
    try {
      const requestUrl = new URL(request.url || '/', config.publicOrigin);
      requestPathname = requestUrl.pathname;
      assertHost(request, config);

      if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
        return sendJson(
          response,
          200,
          {
            ok: true,
            app: APP_NAME,
            version: APP_VERSION,
            shellRevision: SHELL_REVISION,
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
            unlockedUntil: result.unlockedUntil,
            reauthenticationMode: result.reauthenticationMode,
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
        const authentication = await security.verifyAuthentication(
          request,
          body.response,
        );
        const { setCookie, ...result } = authentication;
        return sendJson(
          response,
          200,
          result,
          config,
          setCookie ? { 'Set-Cookie': setCookie } : {},
        );
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/auth/lock') {
        const body = await readJson(request);
        const result = await security.lock(request, {
          explicit: body.explicit === true,
        });
        return sendJson(response, 200, result, config);
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/auth/touch') {
        const result = security.touch(request);
        return sendJson(response, 200, result, config);
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/events') {
        try {
          security.session(request, { requireUnlocked: true });
        } catch (error) {
          response.writeHead(200, {
            ...securityHeaders(config, { api: true }),
            'Content-Type': 'text/event-stream; charset=utf-8',
            Connection: 'close',
            'X-Accel-Buffering': 'no',
          });
          response.end(
            `event: locked\ndata: ${JSON.stringify({
              code: asHttpError(error).code,
            })}\n\n`,
          );
          return;
        }
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
            shellRevision: SHELL_REVISION,
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
          {
            workspaces: database.listWorkspaces(),
            unreadSessions: database.listUnreadSessionHeads?.() || [],
          },
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
      const sessionAttachments = pathMatch(
        requestUrl.pathname,
        /^\/api\/sessions\/([^/]+)\/attachments$/,
      );
      const sessionAttachment = pathMatch(
        requestUrl.pathname,
        /^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)$/,
      );
      const deliveryStatus = pathMatch(
        requestUrl.pathname,
        /^\/api\/sessions\/([^/]+)\/delivery-status$/,
      );
      if (request.method === 'POST' && sessionAttachments) {
        security.assertOrigin(request);
        const auth = security.session(request, {
          requireUnlocked: true,
          requireCsrf: true,
        });
        const route = database.getSessionRoute(sessionAttachments[0]);
        if (!route) throw new HttpError(404, 'session_not_found');
        const workspacePath = attachmentWorkspace(route);
        const key = `${auth.device.id}:${idempotencyKey(request)}`;
        attachmentManager.assertUploadAllowed(auth.device.id);
        const upload = await readImageUpload(request);
        try {
          security.assertOrigin(request);
          const currentAuth = security.session(request, {
            requireUnlocked: true,
            requireCsrf: true,
            touch: false,
          });
          if (currentAuth.device.id !== auth.device.id) {
            throw new HttpError(401, 'device_revoked');
          }
          const currentRoute = database.getSessionRoute(route.id);
          if (
            !currentRoute ||
            attachmentWorkspace(currentRoute) !== workspacePath
          ) {
            throw new HttpError(409, 'session_route_changed');
          }
          const attachment = await attachmentManager.upload({
            key,
            deviceId: auth.device.id,
            sessionId: route.id,
            workspacePath,
            workspacePaths: localAttachmentWorkspacePaths(),
            upload,
          });
          recordAudit({
            phase: 'attachment-uploaded',
            bytes: attachment.bytes,
            width: attachment.width,
            height: attachment.height,
          });
          return sendJson(
            response,
            201,
            { attachment },
            config,
          );
        } finally {
          await upload.cleanup();
        }
      }
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        sessionAttachment
      ) {
        const auth = security.session(request, {
          requireUnlocked: true,
          touch: false,
        });
        const route = database.getSessionRoute(sessionAttachment[0]);
        if (!route) throw new HttpError(404, 'session_not_found');
        const workspacePath = attachmentWorkspace(route);
        const referencedAttachment =
          database.resolveSessionAttachment?.(
            route.id,
            sessionAttachment[1],
          ) || null;
        const requestedVariant =
          requestUrl.searchParams.get('variant') || 'full';
        if (!['full', 'thumbnail'].includes(requestedVariant)) {
          throw new HttpError(400, 'attachment_variant_invalid');
        }
        const image = await attachmentManager.read(
          sessionAttachment[1],
          {
            deviceId: auth.device.id,
            sessionId: route.id,
            workspacePath,
            referencedAttachment,
            variant: requestedVariant,
          },
        );
        return sendImage(response, image, config, {
          head: request.method === 'HEAD',
        });
      }
      if (request.method === 'DELETE' && sessionAttachment) {
        security.assertOrigin(request);
        const auth = security.session(request, {
          requireUnlocked: true,
          requireCsrf: true,
        });
        const route = database.getSessionRoute(sessionAttachment[0]);
        if (!route) throw new HttpError(404, 'session_not_found');
        attachmentWorkspace(route);
        const removed = await attachmentManager.remove(
          sessionAttachment[1],
          {
            deviceId: auth.device.id,
            sessionId: route.id,
            workspacePath: route.workspacePath,
          },
        );
        if (!removed) throw new HttpError(404, 'attachment_not_found');
        response.writeHead(204, securityHeaders(config, { api: true }));
        response.end();
        return;
      }
      // Tab control. Same origin, session, unlock and CSRF gates as every other
      // write path, and the transport's own route proof decides which chat is
      // acted on, so a request can never reach a session the caller did not
      // name. Closing is irreversible, so it additionally requires an explicit
      // confirm flag in the body and the transport re-verifies the selection
      // before and after acting.
      const sessionTabAction = pathMatch(
        requestUrl.pathname,
        /^\/api\/sessions\/([^/]+)\/tab$/,
      );
      if (request.method === 'POST' && sessionTabAction) {
        security.assertOrigin(request);
        security.session(request, {
          requireUnlocked: true,
          requireCsrf: true,
        });
        const route = database.getSessionRoute(sessionTabAction[0]);
        if (!route) throw new HttpError(404, 'session_not_found');
        const body = await readJson(request);
        const action = body?.action;
        const target = {
          workspaceName: route.workspaceName,
          sessionTitle: route.title,
          sessionOrdinal: route.titleOrdinal,
        };
        let result;
        if (action === 'new') {
          // Snapshot before acting so the created chat can be named rather
          // than guessed. Measured on 2026-08-16: by the time the Mac proves
          // the tab exists, Conductor has already written the row, so the
          // lookup below resolves on its first read. Taking the newest row
          // instead would be wrong, since the operator can create a chat on
          // the Mac at the same moment.
          const before = new Set(
            database.listSessions(route.workspaceId).map((row) => row.id),
          );
          result = await transport.newTab(target);
          if (result.ok === true) {
            const appeared = database
              .listSessions(route.workspaceId)
              .filter((row) => !before.has(row.id));
            // Exactly one, or the phone is told nothing and simply refreshes.
            // Navigating to a chat we cannot uniquely identify is worse than
            // leaving the operator where they are.
            result =
              appeared.length === 1
                ? {
                    ...result,
                    createdSessionId: appeared[0].id,
                    createdSessionTitle: appeared[0].title,
                    workspaceId: route.workspaceId,
                    workspaceName: route.workspaceName,
                  }
                : { ...result, workspaceId: route.workspaceId };
          }
        } else if (action === 'close') {
          result = await transport.closeTab(target, {
            confirmClose: body?.confirm === true,
          });
        } else {
          throw new HttpError(400, 'unknown_tab_action');
        }
        recordAudit({
          phase: 'tab-action',
          action,
          ok: result.ok === true,
          code: result.code,
        });
        return sendJson(response, result.ok ? 200 : 409, result, config);
      }

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
        const normalizedMessage = normalizeText(body.message).trim();
        if (hasAttachmentMentionSyntax(normalizedMessage)) {
          throw new HttpError(400, 'message_invalid');
        }
        const attachmentIds =
          body.attachments == null ? [] : body.attachments;
        const attachmentWorkspacePath =
          Array.isArray(attachmentIds) && attachmentIds.length > 0
            ? attachmentWorkspace(route)
            : route.workspacePath;
        const selectedAttachments =
          await attachmentManager.resolveForSend(
            attachmentIds,
            {
              deviceId: auth.device.id,
              sessionId: route.id,
              workspacePath: attachmentWorkspacePath,
            },
          );
        const deliveryMessage = composeAttachmentMessage(
          normalizedMessage,
          selectedAttachments,
        );
        if (Buffer.byteLength(deliveryMessage, 'utf8') > MAX_MESSAGE_BYTES) {
          throw new HttpError(413, 'message_too_large');
        }
        const replaceDraft = body.replaceDraft === true;
        const expectedMacDraft =
          typeof body.expectedMacDraft === 'string'
            ? normalizeText(body.expectedMacDraft)
            : null;
        const fingerprint = sendFingerprint({
          message: deliveryMessage,
          replaceDraft,
          expectedMacDraft,
          attachments: selectedAttachments,
        });
        const traceId = randomUUID();
        const sendStartedAt = Date.now();
        const clientRevision = clientShellRevision(request);
        recordAudit({
          traceId,
          phase: 'accepted',
          clientRevision,
        });
        const deliveryOperation = idempotency.run(
          key,
          route.id,
          fingerprint,
          (setDeliveryPhase) =>
            serializeSend(async () => {
              await setDeliveryPhase('automating');
              recordAudit({
                traceId,
                phase: 'automation-started',
                queueWaitMs: Date.now() - sendStartedAt,
              });
              security.assertOrigin(request);
              const currentAuth = security.session(request, {
                requireUnlocked: true,
                requireCsrf: true,
                touch: false,
              });
              if (currentAuth.device.id !== auth.device.id) {
                throw new HttpError(401, 'device_revoked');
              }
              const beforeRowId =
                database.getSessionMessageCursor(route.id);
              let attachmentsRetained = false;
              let attachmentsReleased = false;
              const markDefinitelyUnsent = async () => {
                deliveryDefinitelyUnsent = true;
                if (
                  !attachmentsRetained ||
                  attachmentsReleased ||
                  selectedAttachments.length === 0
                ) {
                  return;
                }
                attachmentsReleased = true;
                try {
                  await attachmentManager.releaseAfterUnsent(
                    selectedAttachments.map(({ id }) => id),
                    {
                      deviceId: auth.device.id,
                      sessionId: route.id,
                      workspacePath: attachmentWorkspace(route),
                    },
                  );
                } catch {
                  recordAudit({
                    traceId,
                    phase: 'attachment-release-failed',
                  });
                }
              };
              if (selectedAttachments.length > 0) {
                const currentRoute = database.getSessionRoute(route.id);
                if (
                  !currentRoute ||
                  attachmentWorkspace(currentRoute) !==
                    attachmentWorkspace(route)
                ) {
                  throw new HttpError(409, 'session_route_changed');
                }
                await attachmentManager.retainForSend(
                  selectedAttachments.map(({ id }) => id),
                  {
                    deviceId: auth.device.id,
                    sessionId: route.id,
                    workspacePath: attachmentWorkspace(route),
                  },
                );
                attachmentsRetained = true;
              }
              let certifiedPreSend = false;
              try {
                const automationDeadline =
                  Date.now() + SEND_AUTOMATION_RETRY_BUDGET_MS;
                let attributionBaseline = beforeRowId;
                let transportAttempt = 1;
                const definitelyUnsentResult = (code) => ({
                  ok: false,
                  code,
                  safeToRetry: true,
                });
                const recordTransport = (sendResult, attempt) => {
                  recordAudit({
                    traceId,
                    phase: 'transport',
                    attempt,
                    ok: sendResult.ok === true,
                    code: sendResult.code,
                    composerOwned:
                      typeof sendResult.composerOwned === 'boolean'
                        ? sendResult.composerOwned
                        : null,
                    elapsedMs: Date.now() - sendStartedAt,
                    // The underlying osascript failure text, when the
                    // transport preserved one. Without it every automation
                    // failure is undiagnosable from this log.
                    ...(typeof sendResult.detail === 'string' &&
                    sendResult.detail !== ''
                      ? { detail: sendResult.detail.slice(0, 500) }
                      : {}),
                  });
                };
                deliveryTransportStarted = true;
                let sendResult = await transport.send({
                  workspaceName: route.workspaceName,
                  sessionTitle: route.title,
                  sessionOrdinal: route.titleOrdinal,
                  message: deliveryMessage,
                  replaceDraft,
                  expectedMacDraft,
                });
                recordTransport(sendResult, transportAttempt);
                if (
                  !sendResult.ok &&
                  TRANSIENT_PRE_COMPOSER_CODES.has(sendResult.code)
                ) {
                  certifiedPreSend = true;
                  const remainingBeforeRetry =
                    automationDeadline - Date.now();
                  if (remainingBeforeRetry >= 1_000) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    security.assertOrigin(request);
                    const retryAuth = security.session(request, {
                      requireUnlocked: true,
                      requireCsrf: true,
                      touch: false,
                    });
                    if (retryAuth.device.id !== auth.device.id) {
                      throw new HttpError(401, 'device_revoked');
                    }
                    const retryRoute = database.getSessionRoute(route.id);
                    if (
                      !sameSessionRoute(route, retryRoute, {
                        attachments: selectedAttachments.length > 0,
                      })
                    ) {
                      sendResult = definitelyUnsentResult(
                        'session_route_changed',
                      );
                    } else {
                      const retryBeforeRowId =
                        database.getSessionMessageCursor(route.id);
                      let retryBoundary = 'unreadable';
                      try {
                        const cursorValid =
                          Number.isSafeInteger(retryBeforeRowId) &&
                          retryBeforeRowId >= beforeRowId;
                        if (cursorValid) {
                          retryBoundary = database.listUserMessagesAfter(
                            route.id,
                            beforeRowId,
                          ).length === 0
                            ? 'clear'
                            : 'blocked';
                        }
                      } catch {
                        // A database read failure cannot prove a safe retry boundary.
                      }
                      const remainingRetryMs =
                        automationDeadline - Date.now();
                      if (retryBoundary === 'blocked') {
                        sendResult = definitelyUnsentResult(
                          'user_input_active',
                        );
                      } else if (retryBoundary !== 'clear') {
                        // Keep the original structured pre-composer failure.
                      } else if (remainingRetryMs < 1_000) {
                        // Keep the original structured pre-composer failure.
                      } else {
                        attributionBaseline = retryBeforeRowId;
                        transportAttempt += 1;
                        // The structured failure certifies only the completed
                        // attempt. Once another transport starts, its outcome
                        // must be treated as ambiguous until independently
                        // certified or confirmed from the database.
                        certifiedPreSend = false;
                        sendResult = await transport.send({
                          workspaceName: retryRoute.workspaceName,
                          sessionTitle: retryRoute.title,
                          sessionOrdinal: retryRoute.titleOrdinal,
                          message: deliveryMessage,
                          replaceDraft,
                          expectedMacDraft,
                          timeoutMs: Math.min(45_000, remainingRetryMs),
                        });
                        recordTransport(sendResult, transportAttempt);
                      }
                    }
                  }
                }
                if (
                  !sendResult.ok &&
                  sendResult.code === 'composer_changed_pre_send'
                ) {
                  const certificate = parseComposerRetryCertificate(
                    sendResult,
                    deliveryMessage,
                  );
                  if (!certificate) {
                    sendResult = {
                      ok: false,
                      code: 'automation_invalid_response',
                    };
                  } else {
                    certifiedPreSend = true;
                    const retryTimeoutMs =
                      automationDeadline - Date.now();
                    if (retryTimeoutMs < 1_000) {
                      sendResult = definitelyUnsentResult(
                        'composer_changed_pre_send',
                      );
                    } else {
                      let noUserRows = false;
                      try {
                        noUserRows =
                          database.listUserMessagesAfter(
                            route.id,
                            beforeRowId,
                          ).length === 0;
                      } catch {
                        // A database read failure cannot prove a safe retry boundary.
                      }
                      if (!noUserRows) {
                        sendResult =
                          definitelyUnsentResult('user_input_active');
                      } else {
                        security.assertOrigin(request);
                        const retryAuth = security.session(request, {
                          requireUnlocked: true,
                          requireCsrf: true,
                          touch: false,
                        });
                        if (retryAuth.device.id !== auth.device.id) {
                          throw new HttpError(401, 'device_revoked');
                        }
                        const retryRoute =
                          database.getSessionRoute(route.id);
                        if (
                          !sameSessionRoute(route, retryRoute, {
                            attachments:
                              selectedAttachments.length > 0,
                          })
                        ) {
                          sendResult = definitelyUnsentResult(
                            'session_route_changed',
                          );
                        } else {
                          const retryBeforeRowId =
                            database.getSessionMessageCursor(route.id);
                          let retryBoundaryClear = false;
                          try {
                            retryBoundaryClear =
                              Number.isSafeInteger(retryBeforeRowId) &&
                              retryBeforeRowId >= beforeRowId &&
                              database.listUserMessagesAfter(
                                route.id,
                                beforeRowId,
                              ).length === 0;
                          } catch {
                            // Fail closed if the second user-row scan is unreadable.
                          }
                          if (!retryBoundaryClear) {
                            sendResult =
                              definitelyUnsentResult(
                                'user_input_active',
                              );
                          } else {
                            security.assertOrigin(request);
                            const finalRetryAuth =
                              security.session(request, {
                                requireUnlocked: true,
                                requireCsrf: true,
                                touch: false,
                              });
                            if (
                              finalRetryAuth.device.id !==
                              auth.device.id
                            ) {
                              throw new HttpError(
                                401,
                                'device_revoked',
                              );
                            }
                            const finalRetryRoute =
                              database.getSessionRoute(route.id);
                            if (
                              !sameSessionRoute(
                                route,
                                finalRetryRoute,
                                {
                                  attachments:
                                    selectedAttachments.length > 0,
                                },
                              )
                            ) {
                              sendResult = definitelyUnsentResult(
                                'session_route_changed',
                              );
                            } else {
                              const remainingRetryMs =
                                automationDeadline - Date.now();
                              if (remainingRetryMs < 1_000) {
                                sendResult =
                                  definitelyUnsentResult(
                                    'composer_changed_pre_send',
                                  );
                              } else {
                                attributionBaseline =
                                  retryBeforeRowId;
                                // The retry certificate stops at the transport
                                // boundary. Do not let a later exception mark a
                                // started retry as definitely unsent.
                                certifiedPreSend = false;
                                sendResult = await transport.send({
                                  workspaceName:
                                    finalRetryRoute.workspaceName,
                                  sessionTitle:
                                    finalRetryRoute.title,
                                  sessionOrdinal:
                                    finalRetryRoute.titleOrdinal,
                                  message: deliveryMessage,
                                  replaceDraft: true,
                                  expectedMacDraft:
                                    certificate.draft,
                                  expectedInputCounters:
                                    certificate.inputCounters,
                                  timeoutMs: Math.min(
                                    45_000,
                                    remainingRetryMs,
                                  ),
                                });
                                transportAttempt += 1;
                                recordTransport(
                                  sendResult,
                                  transportAttempt,
                                );
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
                if (
                  !sendResult.ok &&
                  sendResult.code === 'send_interrupted' &&
                  sendResult.composerOwned === false
                ) {
                  const interruptedResult = {
                    ok: false,
                    code: 'user_input_active',
                    safeToRetry: true,
                  };
                  await markDefinitelyUnsent();
                  return interruptedResult;
                }
                const attributedTransportFailure =
                  !sendResult.ok &&
                  sendResult.code !== 'send_not_confirmed' &&
                  sendResult.code !== 'send_interrupted' &&
                  sendResult.safeToRetry !== true &&
                  Number.isSafeInteger(sendResult.pressedAt) &&
                  sendResult.pressedAt > 0 &&
                  sendResult.composerOwned === true;
                if (
                  !sendResult.ok &&
                  sendResult.code !== 'send_not_confirmed' &&
                  sendResult.code !== 'send_interrupted' &&
                  !attributedTransportFailure
                ) {
                  // A killed automation reports no press and owns no composer,
                  // so the only open question is whether anything landed. If
                  // Conductor's own transcript also gained no user row, the
                  // message provably did not send, and the phone should offer
                  // Retry instead of a Check that can only ever answer
                  // "unconfirmed" about a message that never existed. Without
                  // this, a 45s timeout is a dead end with no way forward.
                  if (
                    sendResult.safeToRetry !== true &&
                    sendResult.code === 'automation_timeout' &&
                    sendResult.composerOwned !== true &&
                    !(
                      Number.isSafeInteger(sendResult.pressedAt) &&
                      sendResult.pressedAt > 0
                    )
                  ) {
                    let nothingLanded = false;
                    try {
                      nothingLanded =
                        database.listUserMessagesAfter(route.id, beforeRowId)
                          .length === 0;
                    } catch {
                      // An unreadable transcript proves nothing. Stay unconfirmed.
                    }
                    if (nothingLanded) {
                      sendResult = { ...sendResult, safeToRetry: true };
                    }
                  }
                  if (sendResult.safeToRetry === true) {
                    await markDefinitelyUnsent();
                  }
                  return sendResult;
                }
                const confirmationPressedAt = sendResult.pressedAt;
                const confirmationComposerOwned = sendResult.composerOwned;
                const confirmationAttributionWindowMs =
                  sendResult.code === 'send_interrupted'
                    ? SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS
                    : attributedTransportFailure
                      ? SEND_DELIVERY_RECOVERY_ATTRIBUTION_WINDOW_MS
                    : SEND_ATTRIBUTION_WINDOW_MS;
                await setDeliveryPhase('confirming');
                const confirmed = await waitForExactUserMessage({
                  database,
                  sessionId: route.id,
                  afterRowId: attributionBaseline,
                  exactContent: deliveryMessage,
                  pressedAt: confirmationPressedAt,
                  composerOwned: confirmationComposerOwned,
                  timeoutMs:
                    sendResult.code === 'send_interrupted'
                      ? SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS
                      : SEND_CONFIRMATION_TIMEOUT_MS,
                  attributionWindowMs:
                    confirmationAttributionWindowMs,
                });
                if (!confirmed) {
                  if (sendResult.code === 'send_interrupted') {
                    try {
                      const rows = database.listUserMessagesAfter(
                        route.id,
                        attributionBaseline,
                      );
                      if (rows.length === 0) {
                        const interruptedResult = {
                          ok: false,
                          code: 'user_input_active',
                          safeToRetry: true,
                        };
                        await markDefinitelyUnsent();
                        return interruptedResult;
                      }
                    } catch {
                      // Any unreadable or interfering row keeps the result ambiguous.
                    }
                    return {
                      ...sendNotConfirmedResult({
                        baselineCursor: attributionBaseline,
                        contentHash: sha256(deliveryMessage),
                        pressedAt: sendResult.pressedAt,
                        composerOwned: sendResult.composerOwned,
                        attributionWindowMs:
                          SEND_INTERRUPTION_ATTRIBUTION_WINDOW_MS,
                      }),
                    };
                  }
                  if (attributedTransportFailure) {
                    return sendNotConfirmedResult({
                      code: sendResult.code,
                      baselineCursor: attributionBaseline,
                      contentHash: sha256(deliveryMessage),
                      pressedAt: confirmationPressedAt,
                      composerOwned: confirmationComposerOwned,
                      attributionWindowMs:
                        confirmationAttributionWindowMs,
                    });
                  }
                  if (!sendResult.ok) {
                    return sendNotConfirmedResult({
                      baselineCursor: attributionBaseline,
                      contentHash: sha256(deliveryMessage),
                      pressedAt: sendResult.pressedAt,
                      composerOwned: sendResult.composerOwned,
                    });
                  }
                  return sendNotConfirmedResult({
                    baselineCursor: attributionBaseline,
                    contentHash: sha256(deliveryMessage),
                    pressedAt: sendResult.pressedAt,
                    composerOwned: sendResult.composerOwned,
                  });
                }
                return databaseDeliveryResult(
                  confirmed,
                  attributionBaseline,
                );
              } catch (error) {
                if (certifiedPreSend) {
                  await markDefinitelyUnsent();
                  const markedError =
                    error &&
                    (typeof error === 'object' ||
                      typeof error === 'function')
                      ? error
                      : asHttpError(error);
                  markedError.deliveryDefinitelyUnsent = true;
                  throw markedError;
                }
                throw error;
              }
            }),
        );
        if (deliveryOperation.joined) deliveryTransportStarted = true;
        const result = await deliveryOperation.promise;
        recordAudit({
          traceId,
          phase: 'complete',
          ok: result.ok === true,
          code: result.code || (result.ok ? 'delivered' : 'unknown'),
          elapsedMs: Date.now() - sendStartedAt,
        });
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
                ...(result.safeToRetry === true
                  ? { definitelyUnsent: true }
                  : {}),
                // Already redacted at the source (quoted spans and base64
                // runs stripped), so the phone can show why the Mac failed
                // instead of pointing the user at a log they cannot see.
                ...(typeof result.detail === 'string' && result.detail !== ''
                  ? { detail: result.detail.slice(0, 300) }
                  : {}),
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

      // Seat usage, read from the local VDM producer on 3333. Without it the
      // phone can only report what the agent said at the moment it failed, and
      // a limit that has since reset still reads as current. This is the live
      // number, so "am I actually out?" is answerable from the phone.
      if (request.method === 'GET' && requestUrl.pathname === '/api/usage') {
        security.session(request, { requireUnlocked: true });
        return sendJson(response, 200, await usageReader(), config);
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
        try {
          await attachmentManager.purgeDevice?.(revokeDevice[0], {
            workspacePaths: localAttachmentWorkspacePaths(),
          });
        } catch {
          recordAudit({ phase: 'attachment-device-purge-failed' });
        }
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
        {
          error: {
            code: handled.code,
            ...(request.method === 'POST' &&
            /^\/api\/sessions\/[^/]+\/messages$/.test(
              requestPathname || '',
            ) &&
            (error?.deliveryDefinitelyUnsent === true ||
              !deliveryTransportStarted ||
              deliveryDefinitelyUnsent)
              ? { definitelyUnsent: true }
              : {}),
          },
        },
        configStore.value,
      );
    }
  });

  server.on('close', () => {
    unsubscribe();
    watcher.stop();
    attachmentManager.stop?.();
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
        pathname === '/bootstrap-recovery.js' ||
        pathname === '/delivery-receipts.js' ||
        pathname === '/app-update.js' ||
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
