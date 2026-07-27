import {
  discardTerminalUnconfirmedDeliveries,
  reconcileDeliveryReceipts,
} from './delivery-receipts.js?v=0.2.0-unconfirmed-cleanup-1';

const app = document.querySelector('#app');
const overlayRoot = document.querySelector('#overlay-root');
const announcer = document.querySelector('#announcer');
const AWAY_LOCK_MS = 5 * 60 * 1000;
const ACTIVITY_HEARTBEAT_MS = 60 * 1000;
const HIDDEN_AT_KEY = 'cp:hidden-at:v1';
const CLIENT_VERSION = '0.2.0';
const SHELL_CACHE_PREFIX = 'conductor-pocket-shell-';
const CACHE_PURGE_CHANNEL = 'conductor-pocket-cache-purge-v1';
const ORIGIN_RETIRED_KEY = 'cp:origin-retired:v1';
const PENDING_DELIVERIES_KEY = 'pending-deliveries:v1';
const DELIVERY_RECOVERY_MS = 27_000;
const DELIVERY_STATUS_REQUEST_MS = 2_500;

const state = {
  auth: null,
  csrfToken: null,
  connection: 'connecting',
  lastHeartbeat: 0,
  connectionProbe: null,
  eventSource: null,
  heartbeatTimer: null,
  activityTimer: null,
  workspaces: [],
  workspacesLoaded: false,
  recentSessions: [],
  sessionsByWorkspace: new Map(),
  messagesBySession: new Map(),
  cursorsBySession: new Map(),
  route: { view: 'workspaces', workspaceId: null, sessionId: null },
  optimistic: [],
  searchQuery: '',
  shell: null,
  hiddenAt: null,
  seenMessageIds: new Set(),
};

const ICONS = {
  arrowUp: 'i-arrow-up',
  back: 'i-back',
  bolt: 'i-bolt',
  check: 'i-check',
  checkDouble: 'i-check-double',
  chevronDown: 'i-chevron-down',
  close: 'i-close',
  faceid: 'i-faceid',
  gear: 'i-gear',
  laptop: 'i-laptop',
  branch: 'i-branch',
  lock: 'i-lock',
  phone: 'i-phone',
  plus: 'i-plus',
  refresh: 'i-refresh',
  search: 'i-search',
  share: 'i-share',
  squares: 'i-squares',
  terminal: 'i-terminal',
  warn: 'i-warn',
  wifiOff: 'i-wifi-off',
};

function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  if (className) svg.classList.add(...className.split(' '));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${ICONS[name] || name}`);
  svg.append(use);
  return svg;
}

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null) continue;
    if (key === 'className') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'on') {
      for (const [eventName, listener] of Object.entries(value)) {
        element.addEventListener(eventName, listener);
      }
    } else if (key in element && !key.startsWith('aria')) {
      element[key] = value;
    } else {
      element.setAttribute(key, value);
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function button(label, { iconName, className = 'icon-button', onClick } = {}) {
  const attributes = {
    className,
    type: 'button',
    'aria-label': label,
  };
  if (typeof onClick === 'function') attributes.on = { click: onClick };
  const control = node('button', attributes);
  if (iconName) control.append(icon(iconName));
  else control.textContent = label;
  return control;
}

function announce(message) {
  announcer.textContent = '';
  requestAnimationFrame(() => {
    announcer.textContent = message;
  });
}

function formatRelative(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatTime(value = new Date().toISOString()) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function initials(value) {
  return (
    String(value || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || '?'
  );
}

function cappedCount(count) {
  return count > 99 ? '99+' : String(count);
}

function randomIdempotencyKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return toBase64Url(bytes);
}

function fromBase64Url(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function toBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function registrationOptions(options) {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    user: { ...options.user, id: fromBase64Url(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((credential) => ({
      ...credential,
      id: fromBase64Url(credential.id),
    })),
  };
}

function authenticationOptions(options) {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((credential) => ({
      ...credential,
      id: fromBase64Url(credential.id),
    })),
  };
}

function registrationResponse(credential) {
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64Url(credential.response.clientDataJSON),
      attestationObject: toBase64Url(credential.response.attestationObject),
      transports: credential.response.getTransports?.() || [],
      publicKeyAlgorithm: credential.response.getPublicKeyAlgorithm?.(),
      publicKey: credential.response.getPublicKey?.()
        ? toBase64Url(credential.response.getPublicKey())
        : undefined,
      authenticatorData: credential.response.getAuthenticatorData?.()
        ? toBase64Url(credential.response.getAuthenticatorData())
        : undefined,
    },
  };
}

function authenticationResponse(credential) {
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64Url(credential.response.clientDataJSON),
      authenticatorData: toBase64Url(credential.response.authenticatorData),
      signature: toBase64Url(credential.response.signature),
      userHandle: credential.response.userHandle
        ? toBase64Url(credential.response.userHandle)
        : null,
    },
  };
}

async function request(pathname, { method = 'GET', body, csrf = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(pathname, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.code || `http_${response.status}`);
    error.code = payload.error?.code || `http_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function gateView({ mark = 'bolt', title, body, content, action, secondary }) {
  state.shell?.composer.observer?.disconnect();
  state.shell = null;
  const markNode = node('div', { className: 'app-mark' }, icon(mark));
  const column = node('div', { className: 'gate-column' }, [
    markNode,
    node('h1', { text: title }),
    body ? node('p', { className: 'gate-lede', text: body }) : null,
    content,
    action,
    secondary,
  ]);
  app.replaceChildren(node('main', { className: 'gate' }, column));
}

function skeletonRows(count = 6) {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < count; index += 1) {
    fragment.append(
      node('div', { className: 'skeleton-row', 'aria-hidden': 'true' }, [
        node('div', { className: 'skeleton-block skeleton-monogram' }),
        node('div', {}, [
          node('div', { className: 'skeleton-block skeleton-copy' }),
          node('div', { className: 'skeleton-block skeleton-copy short' }),
        ]),
      ]),
    );
  }
  return fragment;
}

async function initializePairing(code) {
  gateView({
    title: 'Conductor Pocket',
    body: "Remote for your Mac's Conductor",
    content: node('div', { className: 'pair-card' }, skeletonRows(3)),
  });
  try {
    const pairing = await request('/api/pair/start', {
      method: 'POST',
      body: { code, deviceName: /iPhone/i.test(navigator.userAgent) ? 'This iPhone' : 'This device' },
    });
    renderPairing(pairing);
  } catch (error) {
    renderPairingExpired(error.code);
  }
}

function renderPairing(pairing) {
  const card = node('section', { className: 'pair-card' }, [
    node('div', { className: 'micro-caps', text: 'Pairing with' }),
    node('div', { className: 'pair-mac', text: pairing.macName }),
    node('div', { className: 'machine-fact', text: pairing.hostname }),
    node('div', { className: 'pair-divider' }),
    node('div', { className: 'micro-caps', text: 'Verification code' }),
    node('div', { className: 'verification-code', text: pairing.verificationCode }),
    node('p', {
      className: 'pair-help',
      text: "The Mac terminal is showing the same code. If they don't match, don't pair.",
    }),
  ]);
  const action = node('button', {
    className: 'primary-button',
    type: 'button',
    text: 'The code matches - Pair',
    on: {
      click: async (event) => {
        const control = event.currentTarget;
        control.disabled = true;
        control.textContent = 'Waiting for Face ID…';
        try {
          if (!window.PublicKeyCredential) throw new Error('passkey_unavailable');
          const credential = await navigator.credentials.create({
            publicKey: registrationOptions(pairing.options),
          });
          const result = await request('/api/pair/finish', {
            method: 'POST',
            body: { response: registrationResponse(credential) },
          });
          history.replaceState({}, '', '/');
          state.auth = result;
          state.csrfToken = result.csrfToken;
          if (isStandalone()) {
            await startApplication();
          } else {
            renderInstallGuidance({ firstRun: true });
          }
        } catch (error) {
          control.disabled = false;
          control.textContent = 'The code matches - Pair';
          let errorLine = card.querySelector('.inline-error');
          if (!errorLine) {
            errorLine = node('p', { className: 'inline-error' });
            card.append(errorLine);
          }
          errorLine.textContent =
            error.name === 'NotAllowedError'
              ? "Face ID wasn't set up. Try again."
              : 'Pairing could not be completed. Generate a new link on your Mac.';
        }
      },
    },
  });
  gateView({
    title: 'Conductor Pocket',
    body: "Remote for your Mac's Conductor",
    content: card,
    action,
  });
}

function renderPairingExpired(code) {
  const card = node('section', { className: 'pair-card' }, [
    icon('warn'),
    node('div', { className: 'pair-mac', text: 'This link has expired' }),
    node('p', {
      className: 'pair-help',
      text:
        code === 'tailscale_identity_required'
          ? 'Connect this phone to the same Tailscale network, then open a fresh pairing link.'
          : 'Pairing links work once. Generate a new one from the Conductor Pocket setup command on your Mac.',
    }),
  ]);
  gateView({
    mark: 'warn',
    title: 'Pairing unavailable',
    content: card,
  });
}

async function bootstrap() {
  try {
    const auth = await request('/api/auth/bootstrap');
    state.auth = auth;
    state.csrfToken = auth.csrfToken;
    if (auth.unlocked) await startApplication();
    else renderLock();
  } catch (error) {
    if (error.status === 401 || error.code === 'device_revoked') {
      await purgeThenRenderSignedOut();
    } else {
      renderConnectionGate(error.code);
    }
  }
}

function renderLock({ errorMessage = '' } = {}) {
  stopEvents();
  state.shell = null;
  state.messagesBySession.clear();
  state.cursorsBySession.clear();
  state.optimistic = [];
  state.seenMessageIds.clear();
  const action = node('button', {
    className: 'primary-button',
    type: 'button',
    text: 'Unlock with Face ID',
    on: {
      click: async (event) => {
        const control = event.currentTarget;
        control.disabled = true;
        control.textContent = 'Waiting for Face ID…';
        try {
          const options = await request('/api/auth/options', {
            method: 'POST',
            body: {},
            csrf: true,
          });
          const credential = await navigator.credentials.get({
            publicKey: authenticationOptions(options),
          });
          const auth = await request('/api/auth/verify', {
            method: 'POST',
            body: { response: authenticationResponse(credential) },
            csrf: true,
          });
          state.auth = { ...state.auth, ...auth };
          state.csrfToken = auth.csrfToken;
          await startApplication();
        } catch (error) {
          renderLock({
            errorMessage:
              error.name === 'NotAllowedError'
                ? 'Face ID was canceled. Try again.'
                : 'Face ID could not unlock this remote. Try again.',
          });
        }
      },
    },
  });
  const content = errorMessage
    ? node('p', { className: 'inline-error', text: errorMessage })
    : null;
  gateView({
    mark: 'bolt',
    title: 'Locked',
    body: 'Your Conductor chats stay hidden until you verify.',
    content,
    action,
  });
}

function renderSignedOut() {
  stopEvents();
  state.auth = null;
  state.csrfToken = null;
  state.workspaces = [];
  state.recentSessions = [];
  state.sessionsByWorkspace.clear();
  state.messagesBySession.clear();
  state.cursorsBySession.clear();
  state.optimistic = [];
  state.seenMessageIds.clear();
  gateView({
    mark: 'lock',
    title: 'This device was signed out',
    body:
      'Its access was revoked or expired. Pair again with a fresh link from your Mac.',
    content: node('p', {
      className: 'machine-fact',
      text: 'npm run pair',
    }),
  });
}

function isLocalPurgeFailure(error) {
  return /transcript_cache_delete|service_worker_retirement|other_pocket_window|origin_retired|cache/i.test(
    error?.message || '',
  );
}

function renderLocalPurgeFailure(retry) {
  stopEvents();
  gateView({
    mark: 'warn',
    title: 'Local data was not erased',
    body:
      'Close every other Pocket window on this phone, then retry. This device stays enrolled until the cleanup finishes.',
    action: node('button', {
      className: 'primary-button',
      type: 'button',
      text: 'Retry cleanup',
      on: { click: retry },
    }),
  });
}

async function purgeThenRenderSignedOut() {
  try {
    await purgeLocalData();
    renderSignedOut();
  } catch {
    renderLocalPurgeFailure(() => purgeThenRenderSignedOut());
  }
}

function renderConnectionGate(code) {
  const upgradeRequired = code === 'retirement_client_upgrade_required';
  gateView({
    mark: upgradeRequired ? 'refresh' : 'wifiOff',
    title: upgradeRequired ? 'Pocket must refresh' : 'Mac unreachable',
    body:
      upgradeRequired
        ? 'Fully close Pocket, reopen it while online, then sign out again. The old app cannot retire this phone.'
        : code === 'tailscale_identity_required'
        ? 'Connect this phone to your private Tailscale network, then try again.'
        : 'Conductor Pocket could not reach the relay on your Mac.',
    action: node('button', {
      className: 'primary-button',
      type: 'button',
      text: upgradeRequired ? 'Reload Pocket' : 'Try again',
      on: {
        click: () => {
          if (upgradeRequired) location.reload();
          else bootstrap();
        },
      },
    }),
  });
}

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function renderInstallGuidance({ firstRun = false } = {}) {
  const steps = node('ol', { className: 'install-steps' });
  const values = [
    ['Tap the Share button in Safari', 'share'],
    ['Choose “Add to Home Screen”', 'plus'],
    ['Open Conductor Pocket from your Home Screen', 'bolt'],
  ];
  values.forEach(([copy, iconName], index) => {
    steps.append(
      node('li', { className: 'install-step' }, [
        node('span', { className: 'install-number', text: String(index + 1) }),
        node('span', { text: copy }),
        icon(iconName),
      ]),
    );
  });
  gateView({
    title: 'Install Conductor Pocket',
    body: 'Run it full-screen, off the Home Screen, like an app.',
    content: steps,
    action: node('button', {
      className: 'primary-button',
      type: 'button',
      text: firstRun ? 'Continue in Safari' : 'Done',
      on: { click: () => startApplication() },
    }),
  });
}

function loadRoute() {
  try {
    const parsed = JSON.parse(localStorage.getItem('cp:last-route:v1'));
    if (parsed && ['workspaces', 'sessions', 'transcript'].includes(parsed.view)) {
      return parsed;
    }
  } catch {
    // Ignore malformed local state.
  }
  return { view: 'workspaces', workspaceId: null, sessionId: null };
}

function persistRoute() {
  localStorage.setItem('cp:last-route:v1', JSON.stringify(state.route));
}

function loadDrafts() {
  try {
    return JSON.parse(localStorage.getItem('cp:drafts:v1')) || {};
  } catch {
    return {};
  }
}

function draftFor(sessionId) {
  return loadDrafts()[sessionId] || '';
}

function saveDraft(sessionId, value) {
  if (!sessionId) return;
  const drafts = loadDrafts();
  if (value) drafts[sessionId] = value.slice(0, 16 * 1024);
  else delete drafts[sessionId];
  localStorage.setItem('cp:drafts:v1', JSON.stringify(drafts));
}

let cacheDatabasePromise;
let originRetired = localStorage.getItem(ORIGIN_RETIRED_KEY) === '1';
const cachePurgeChannel =
  'BroadcastChannel' in window
    ? new BroadcastChannel(CACHE_PURGE_CHANNEL)
    : null;
let serviceWorkerRegistrationPromise = null;

function cacheDatabase() {
  if (
    originRetired ||
    localStorage.getItem(ORIGIN_RETIRED_KEY) === '1'
  ) {
    originRetired = true;
    return Promise.reject(new Error('origin_retired'));
  }
  if (!cacheDatabasePromise) {
    cacheDatabasePromise = new Promise((resolve, reject) => {
      const open = indexedDB.open('conductor-pocket-v1', 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('snapshots')) {
          open.result.createObjectStore('snapshots');
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  return cacheDatabasePromise;
}

async function closeCacheDatabase() {
  try {
    const database = await cacheDatabasePromise;
    database?.close();
  } catch {
    // A failed cache open has nothing to close.
  }
  cacheDatabasePromise = null;
}

cachePurgeChannel?.addEventListener('message', (event) => {
  if (event.data?.type === 'retire-origin') {
    originRetired = true;
    stopEvents();
    void closeCacheDatabase();
  } else if (event.data?.type === 'close-transcript-database') {
    void closeCacheDatabase();
  }
});

async function cacheGet(key) {
  try {
    const database = await cacheDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('snapshots', 'readonly');
      const requestValue = transaction.objectStore('snapshots').get(key);
      requestValue.onsuccess = () => resolve(requestValue.result);
      requestValue.onerror = () => reject(requestValue.error);
    });
  } catch {
    return null;
  }
}

async function cacheSet(key, value) {
  try {
    const database = await cacheDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('snapshots', 'readwrite');
      transaction.objectStore('snapshots').put(value, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // Cache failures never block the live path.
  }
}

async function cacheSetRequired(key, value) {
  const database = await cacheDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('snapshots', 'readwrite');
    transaction.objectStore('snapshots').put(value, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () =>
      reject(transaction.error || new Error('cache_write_failed'));
    transaction.onabort = () =>
      reject(transaction.error || new Error('cache_write_aborted'));
  });
}

function validPersistedKey(value) {
  return (
    typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 100 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function sanitizePendingDelivery(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.kind !== 'optimistic' ||
    typeof value.id !== 'string' ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    value.sessionId.length > 200 ||
    typeof value.text !== 'string' ||
    value.text.length > 16 * 1024 ||
    !validPersistedKey(value.idempotencyKey)
  ) {
    return null;
  }
  const delivery = new Set([
    'delivering',
    'confirming',
    'delivered',
    'failed',
  ]).has(value.delivery)
    ? value.delivery
    : 'confirming';
  return {
    id: value.id,
    idempotencyKey: value.idempotencyKey,
    activeDeliveryKey: validPersistedKey(value.activeDeliveryKey)
      ? value.activeDeliveryKey
      : value.idempotencyKey,
    replaceIdempotencyKey: validPersistedKey(value.replaceIdempotencyKey)
      ? value.replaceIdempotencyKey
      : null,
    kind: 'optimistic',
    sessionId: value.sessionId,
    text: value.text,
    delivery,
    createdAt:
      typeof value.createdAt === 'string'
        ? value.createdAt
        : new Date().toISOString(),
    deliveredAt:
      typeof value.deliveredAt === 'string' ? value.deliveredAt : null,
    receiptBaselineCursor: Number.isSafeInteger(
      value.receiptBaselineCursor,
    )
      ? value.receiptBaselineCursor
      : null,
    receiptRowId: Number.isSafeInteger(value.receiptRowId)
      ? value.receiptRowId
      : null,
    retrySafe: value.retrySafe === true,
    errorCode:
      typeof value.errorCode === 'string' ? value.errorCode : null,
    replaceDraft: value.replaceDraft === true,
    macDraft:
      typeof value.macDraft === 'string'
        ? value.macDraft.slice(0, 16 * 1024)
        : null,
  };
}

function pendingDeliverySnapshot() {
  return state.optimistic
    .map(sanitizePendingDelivery)
    .filter(Boolean);
}

function discardTerminalUnconfirmed() {
  const result = discardTerminalUnconfirmedDeliveries(state.optimistic);
  state.optimistic = result.remaining;
  return result.discarded;
}

async function persistPendingDeliveries({ required = false } = {}) {
  discardTerminalUnconfirmed();
  const snapshot = pendingDeliverySnapshot();
  if (required) {
    await cacheSetRequired(PENDING_DELIVERIES_KEY, snapshot);
  } else {
    await cacheSet(PENDING_DELIVERIES_KEY, snapshot);
  }
}

async function restorePendingDeliveries() {
  const cached = await cacheGet(PENDING_DELIVERIES_KEY);
  state.optimistic = Array.isArray(cached)
    ? cached.map(sanitizePendingDelivery).filter(Boolean)
    : [];
  if (discardTerminalUnconfirmed().length > 0) {
    await cacheSet(PENDING_DELIVERIES_KEY, pendingDeliverySnapshot());
  }
}

async function clearTranscriptCache() {
  cachePurgeChannel?.postMessage({ type: 'close-transcript-database' });
  await closeCacheDatabase();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('transcript_cache_delete_blocked')),
      5_000,
    );
    const requestValue = indexedDB.deleteDatabase('conductor-pocket-v1');
    requestValue.onsuccess = () => {
      clearTimeout(timeout);
      resolve();
    };
    requestValue.onerror = () => {
      clearTimeout(timeout);
      reject(requestValue.error || new Error('transcript_cache_delete_failed'));
    };
    requestValue.onblocked = () => {
      // Another Pocket window receives the BroadcastChannel close request.
      // If it does not release the database, the timeout fails closed.
    };
  });
}

async function assertOnlyRetiringWindow() {
  if (!('serviceWorker' in navigator)) return;
  const registration = serviceWorkerRegistrationPromise
    ? await serviceWorkerRegistrationPromise
    : await navigator.serviceWorker.ready;
  await registration.update();
  const candidate = registration.installing || registration.waiting;
  if (candidate && candidate.state !== 'activated') {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('service_worker_retirement_timeout')),
        4_000,
      );
      const onStateChange = () => {
        if (candidate.state === 'activated') {
          clearTimeout(timeout);
          candidate.removeEventListener('statechange', onStateChange);
          resolve();
        } else if (candidate.state === 'redundant') {
          clearTimeout(timeout);
          candidate.removeEventListener('statechange', onStateChange);
          reject(new Error('service_worker_retirement_unavailable'));
        }
      };
      candidate.addEventListener('statechange', onStateChange);
      onStateChange();
    });
  }
  const worker =
    registration.active || registration.waiting || registration.installing;
  if (!worker) throw new Error('service_worker_retirement_unavailable');
  const requestId = crypto.randomUUID
    ? crypto.randomUUID()
    : randomIdempotencyKey();
  const response = await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(
      () => reject(new Error('service_worker_retirement_timeout')),
      2_000,
    );
    channel.port1.onmessage = (event) => {
      if (
        event.data?.type === 'retirement-window-count' &&
        event.data?.requestId === requestId
      ) {
        clearTimeout(timeout);
        resolve(event.data);
      }
    };
    worker.postMessage(
      { type: 'retirement-window-count', requestId },
      [channel.port2],
    );
  });
  if (response.count !== 1) {
    throw new Error('other_pocket_window_open');
  }
}

async function purgeLocalData() {
  originRetired = true;
  localStorage.setItem(ORIGIN_RETIRED_KEY, '1');
  cachePurgeChannel?.postMessage({ type: 'retire-origin' });
  await assertOnlyRetiringWindow();
  localStorage.removeItem('cp:last-route:v1');
  localStorage.removeItem('cp:drafts:v1');
  localStorage.removeItem(HIDDEN_AT_KEY);
  await clearTranscriptCache();
  if ('caches' in window) {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(SHELL_CACHE_PREFIX))
        .map((name) => caches.delete(name)),
    );
  }
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations.map(async (registration) => {
        const worker =
          registration.active || registration.waiting || registration.installing;
        if (!worker) return;
        const scriptUrl = new URL(worker.scriptURL);
        if (
          scriptUrl.origin === location.origin &&
          scriptUrl.pathname === '/service-worker.js'
        ) {
          await registration.unregister();
        }
      }),
    );
    const remaining = await navigator.serviceWorker.getRegistrations();
    if (
      remaining.some((registration) => {
        const worker =
          registration.active || registration.waiting || registration.installing;
        if (!worker) return false;
        const scriptUrl = new URL(worker.scriptURL);
        return (
          scriptUrl.origin === location.origin &&
          scriptUrl.pathname === '/service-worker.js'
        );
      })
    ) {
      throw new Error('service_worker_retirement_failed');
    }
  }
}

async function startApplication() {
  localStorage.removeItem(HIDDEN_AT_KEY);
  state.hiddenAt = null;
  state.route = loadRoute();
  state.workspacesLoaded = false;
  await restorePendingDeliveries();
  ensureShell();
  updateRoutePanels();
  const cachedWorkspaces = await cacheGet('workspaces');
  if (Array.isArray(cachedWorkspaces)) {
    state.workspaces = cachedWorkspaces;
    renderWorkspacePanel();
  }
  await refreshWorkspaces();
  await loadRecentSessions();
  await restoreRoute();
  startEvents();
  void recoverPendingDeliveries();
}

async function restoreRoute() {
  if (!state.route.workspaceId && state.route.sessionId) {
    const recent = state.recentSessions.find((session) => session.id === state.route.sessionId);
    state.route.workspaceId = recent?.workspaceId || null;
  }
  const workspace = state.workspaces.find((item) => item.id === state.route.workspaceId);
  if (!workspace) {
    navigate({ view: 'workspaces', workspaceId: null, sessionId: null }, false);
    return;
  }
  await loadSessions(workspace.id);
  if (state.route.view === 'transcript') {
    const session = sessionsFor(workspace.id).find(
      (item) => item.id === state.route.sessionId,
    );
    if (!session) {
      navigate({ view: 'sessions', workspaceId: workspace.id, sessionId: null }, false);
      return;
    }
    await openSession(session.id, { push: false });
  } else {
    renderSessionsPanel();
  }
}

function ensureShell() {
  if (state.shell && app.contains(state.shell.root)) return;
  const workspacePanel = node('aside', {
    className: 'panel workspace-panel',
    'aria-label': 'Workspaces',
  });
  const sessionPanel = node('aside', {
    className: 'panel sessions-panel',
    'aria-label': 'Chats',
  });
  const transcriptPanel = node('main', {
    className: 'panel transcript-panel',
    'aria-label': 'Transcript',
  });
  const root = node('div', { className: 'app-shell' }, [
    workspacePanel,
    sessionPanel,
    transcriptPanel,
  ]);
  app.replaceChildren(root);

  const sessionNav = createPanelNav({
    backLabel: 'Workspaces',
    onBack: () => navigate({ view: 'workspaces', workspaceId: null, sessionId: null }),
    onSwitcher: openSwitcher,
  });
  const sessionContent = node('div', { className: 'panel-content' });
  sessionPanel.append(sessionNav.root, sessionContent);

  const transcriptNav = createPanelNav({
    backLabel: 'Chats',
    onBack: () =>
      navigate({
        view: 'sessions',
        workspaceId: state.route.workspaceId,
        sessionId: null,
      }),
    onSwitcher: openSwitcher,
    titleClick: openSwitcher,
  });
  const transcriptBanner = node('div');
  const transcriptScroll = node('div', { className: 'transcript-scroll' });
  const transcriptColumn = node('div', { className: 'transcript-column' });
  const messageList = node('ol', {
    className: 'message-list',
    'aria-label': 'Conversation',
  });
  const statusRow = node('div');
  transcriptColumn.append(messageList, statusRow);
  transcriptScroll.append(transcriptColumn);
  const latestButton = node(
    'button',
    {
      className: 'latest-button',
      type: 'button',
      hidden: true,
      on: {
        click: () => {
          transcriptScroll.scrollTo({ top: transcriptScroll.scrollHeight, behavior: 'smooth' });
          latestButton.hidden = true;
        },
      },
    },
    [icon('chevronDown'), 'Latest'],
  );
  const composer = createComposer();
  transcriptPanel.append(
    transcriptNav.root,
    transcriptBanner,
    transcriptScroll,
    latestButton,
    composer.root,
  );
  transcriptScroll.addEventListener('scroll', () => {
    const distance =
      transcriptScroll.scrollHeight -
      transcriptScroll.clientHeight -
      transcriptScroll.scrollTop;
    latestButton.hidden = distance < 120;
    transcriptNav.root.classList.toggle('is-scrolled', transcriptScroll.scrollTop > 1);
  });

  state.shell = {
    root,
    workspacePanel,
    sessionPanel,
    sessionContent,
    sessionNav,
    transcriptPanel,
    transcriptNav,
    transcriptBanner,
    transcriptScroll,
    messageList,
    statusRow,
    latestButton,
    composer,
  };
  renderWorkspacePanel();
  renderSessionsPanel();
}

function createPanelNav({ backLabel, onBack, onSwitcher, titleClick }) {
  const back = button(backLabel, {
    iconName: 'back',
    className: 'icon-button nav-back',
    onClick: onBack,
  });
  const titleButton = node('button', {
    type: 'button',
    'aria-label': titleClick ? 'Open chat switcher' : undefined,
    on: titleClick ? { click: titleClick } : undefined,
  });
  const heading = node('span', { className: 'nav-heading' });
  const subtitle = node('span', { className: 'nav-subtitle' });
  titleButton.append(heading, subtitle);
  const title = node('div', { className: 'panel-nav-title' }, titleButton);
  const switcher = button('Open chat switcher', {
    iconName: 'squares',
    onClick: onSwitcher,
  });
  const root = node('header', { className: 'panel-nav' }, [back, title, switcher]);
  return { root, heading, subtitle, back, switcher };
}

function createComposer() {
  const draftNote = node('div', { className: 'draft-note', hidden: true });
  const field = node('textarea', {
    className: 'composer-field',
    placeholder: 'Message',
    rows: 1,
    maxlength: 16384,
    'aria-label': 'Message',
  });
  const disc = node('span', { className: 'button-disc' }, icon('arrowUp'));
  const send = node('button', {
    className: 'send-button',
    type: 'button',
    disabled: true,
    'aria-label': 'Send message',
  }, disc);
  const reason = node('button', {
    className: 'send-reason',
    type: 'button',
    hidden: true,
    on: { click: openConnectionSheet },
  });
  const inner = node('div', { className: 'composer-inner' }, [field, send, reason]);
  const root = node('div', { className: 'composer-dock' }, [draftNote, inner]);
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    const borderBox = Array.isArray(entry?.borderBoxSize)
      ? entry.borderBoxSize[0]
      : entry?.borderBoxSize;
    const height = Math.ceil(borderBox?.blockSize || root.getBoundingClientRect().height);
    if (height > 0) {
      document.documentElement.style.setProperty(
        '--composer-height',
        `${height}px`,
      );
    }
  });
  observer.observe(root);
  const resize = () => {
    field.rows = Math.max(1, Math.min(6, field.value.split('\n').length));
  };
  field.addEventListener('input', () => {
    saveDraft(state.route.sessionId, field.value);
    resize();
    renderComposerState();
  });
  field.addEventListener('keydown', (event) => {
    const touchAppleDevice =
      /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const hardwareKeyboard = !touchAppleDevice && event.key === 'Enter';
    if (hardwareKeyboard && !event.shiftKey) {
      event.preventDefault();
      sendCurrentMessage();
    }
  });
  send.addEventListener('click', sendCurrentMessage);
  return { root, field, send, reason, draftNote, resize, observer };
}

function updateRoutePanels() {
  if (!state.shell) return;
  const { view } = state.route;
  state.shell.workspacePanel.classList.toggle('is-active', view === 'workspaces');
  state.shell.sessionPanel.classList.toggle('is-active', view === 'sessions');
  state.shell.transcriptPanel.classList.toggle('is-active', view === 'transcript');
}

function navigate(route, push = true) {
  state.route = route;
  persistRoute();
  if (push) history.pushState({ pocketRoute: route }, '', '/');
  updateRoutePanels();
  renderWorkspacePanel();
  renderSessionsPanel();
  if (route.view === 'transcript' && route.sessionId) openSession(route.sessionId, { push: false });
}

async function refreshWorkspaces() {
  try {
    const data = await request('/api/workspaces');
    state.workspaces = data.workspaces;
    state.workspacesLoaded = true;
    await cacheSet('workspaces', state.workspaces);
    renderWorkspacePanel();
  } catch (error) {
    handleRuntimeError(error);
  }
}

async function loadRecentSessions() {
  try {
    const data = await request('/api/sessions/recent?limit=100');
    state.recentSessions = data.sessions;
    await cacheSet('recent-sessions', data.sessions);
  } catch {
    const cached = await cacheGet('recent-sessions');
    if (Array.isArray(cached)) state.recentSessions = cached;
  }
}

async function loadSessions(workspaceId) {
  const cached = await cacheGet(`sessions:${workspaceId}`);
  if (Array.isArray(cached) && !state.sessionsByWorkspace.has(workspaceId)) {
    state.sessionsByWorkspace.set(workspaceId, cached);
    renderSessionsPanel();
  }
  try {
    const data = await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`);
    state.sessionsByWorkspace.set(workspaceId, data.sessions);
    await cacheSet(`sessions:${workspaceId}`, data.sessions);
    renderSessionsPanel();
  } catch (error) {
    handleRuntimeError(error);
  }
}

function sessionsFor(workspaceId) {
  return state.sessionsByWorkspace.get(workspaceId) || [];
}

function connectionVoice() {
  if (state.connection === 'live') return { text: 'Live', className: '', dot: 'live' };
  if (state.connection === 'offline') {
    return { text: 'Mac unreachable', className: 'down', iconName: 'wifiOff' };
  }
  return { text: 'Reconnecting…', className: 'wait', iconName: 'refresh' };
}

function renderConnectionVoice(container) {
  const voice = connectionVoice();
  container.replaceChildren();
  container.className = `connection-voice ${voice.className === 'down' ? 'is-down' : voice.className === 'wait' ? 'is-wait' : ''}`;
  if (voice.dot) container.append(node('span', { className: `status-dot ${voice.dot}` }));
  else container.append(icon(voice.iconName));
  container.append(document.createTextNode(voice.text));
}

function renderWorkspacePanel() {
  if (!state.shell) return;
  const panel = state.shell.workspacePanel;
  const connection = node('div', { className: 'connection-voice' });
  renderConnectionVoice(connection);
  const header = node('header', { className: 'root-header' }, [
    node('div', {}, [node('h1', { className: 'root-title', text: 'Workspaces' }), connection]),
    node('div', { className: 'root-actions' }, [
      button('Open chat switcher', { iconName: 'squares', onClick: openSwitcher }),
      button('Security and devices', { iconName: 'gear', onClick: openSecurity }),
    ]),
  ]);
  const searchInput = node('input', {
    className: 'search-input',
    type: 'search',
    value: state.searchQuery,
    placeholder: 'Search workspaces and chats',
    'aria-label': 'Search workspaces and chats',
    on: {
      input: (event) => {
        state.searchQuery = event.currentTarget.value;
        renderWorkspacePanel();
        requestAnimationFrame(() => {
          const replacement = state.shell.workspacePanel.querySelector('.search-input');
          replacement?.focus({ preventScroll: true });
          replacement?.setSelectionRange(
            state.searchQuery.length,
            state.searchQuery.length,
          );
        });
      },
    },
  });
  const search = node('div', { className: 'search-wrap' }, [
    icon('search'),
    searchInput,
  ]);
  const content = node('div', { className: 'panel-content' }, [header, search]);

  if (!state.workspacesLoaded && state.workspaces.length === 0) {
    content.append(skeletonRows(6));
  } else if (state.workspaces.length === 0) {
    content.append(
      node('div', { className: 'empty-state' }, [
        icon('laptop'),
        node('h2', { text: 'No workspaces yet' }),
        node('p', {
          text: "Open Conductor on your Mac and they'll appear here.",
        }),
      ]),
    );
  } else if (state.searchQuery.trim()) {
    renderSearchResults(content);
  } else {
    const active = state.workspaces.filter((workspace) => workspace.workingCount > 0);
    const recent = state.workspaces.filter((workspace) => !active.includes(workspace)).slice(0, 5);
    const remainder = state.workspaces
      .filter((workspace) => !active.includes(workspace) && !recent.includes(workspace))
      .sort((left, right) => left.name.localeCompare(right.name));
    appendWorkspaceSection(content, 'Active', active);
    appendWorkspaceSection(content, 'Recent', recent);
    appendWorkspaceSection(content, 'All', remainder);
  }
  panel.replaceChildren(content);
}

function renderSearchResults(content) {
  const query = state.searchQuery.trim().toLowerCase();
  const workspaces = state.workspaces.filter((workspace) =>
    `${workspace.name} ${workspace.branch || ''}`.toLowerCase().includes(query),
  );
  const sessions = state.recentSessions.filter((session) =>
    `${session.title} ${session.workspaceName}`.toLowerCase().includes(query),
  );
  appendWorkspaceSection(content, 'Workspaces', workspaces);
  if (sessions.length) {
    const list = node('ul', { className: 'row-list' });
    for (const session of sessions) list.append(sessionRow(session, { crossWorkspace: true }));
    content.append(node('h2', { className: 'section-heading', text: 'Chats' }), list);
  }
  if (!workspaces.length && !sessions.length) {
    content.append(
      node('div', { className: 'empty-state' }, [
        icon('search'),
        node('h2', { text: `No matches for “${state.searchQuery.trim()}”` }),
      ]),
    );
  }
}

function appendWorkspaceSection(content, title, workspaces) {
  if (!workspaces.length) return;
  const list = node('ul', { className: 'row-list' });
  for (const workspace of workspaces) list.append(workspaceRow(workspace));
  content.append(node('h2', { className: 'section-heading', text: title }), list);
}

function workspaceRow(workspace) {
  const subtitle = node('span', { className: 'row-subtitle' }, [
    icon('branch'),
    workspace.branch || 'No branch',
  ]);
  const meta = node('span', { className: 'row-meta' });
  if (workspace.workingCount > 0) {
    meta.append(
      node('span', { className: 'row-status' }, [
        node('span', { className: 'status-dot working' }),
        workspace.workingCount > 1 ? String(workspace.workingCount) : null,
      ]),
    );
  } else if (workspace.unreadCount > 0) {
    meta.append(node('span', { className: 'badge', text: cappedCount(workspace.unreadCount) }));
  } else {
    meta.textContent = formatRelative(workspace.activityAt);
  }
  const control = node('button', {
    className: 'data-row',
    type: 'button',
    'aria-current': state.route.workspaceId === workspace.id ? 'true' : 'false',
    on: {
      click: async () => {
        await loadSessions(workspace.id);
        navigate({ view: 'sessions', workspaceId: workspace.id, sessionId: null });
      },
    },
  }, [
    node('span', { className: 'row-monogram', text: initials(workspace.name) }),
    node('span', { className: 'row-copy' }, [
      node('span', { className: 'row-title', text: workspace.name }),
      subtitle,
    ]),
    meta,
  ]);
  return node('li', {}, control);
}

function renderSessionsPanel() {
  if (!state.shell) return;
  const workspace = state.workspaces.find((item) => item.id === state.route.workspaceId);
  const { sessionNav, sessionContent } = state.shell;
  sessionNav.heading.textContent = workspace?.name || 'Chats';
  updateNavSubtitle(sessionNav.subtitle, workspace?.branch || connectionVoice().text);
  sessionContent.replaceChildren();
  if (!workspace) {
    sessionContent.append(
      node('div', { className: 'empty-state' }, [
        icon('terminal'),
        node('h2', { text: 'Choose a workspace' }),
      ]),
    );
    return;
  }
  const sessions = sessionsFor(workspace.id);
  if (!state.sessionsByWorkspace.has(workspace.id)) {
    sessionContent.append(skeletonRows(6));
    return;
  }
  if (!sessions.length) {
    sessionContent.append(
      node('div', { className: 'empty-state' }, [
        icon('terminal'),
        node('h2', { text: 'No chats in this workspace' }),
        node('p', { text: 'Start one from your Mac.' }),
      ]),
    );
    return;
  }
  const list = node('ul', { className: 'row-list' });
  sessions.forEach((session) => list.append(sessionRow(session)));
  sessionContent.append(list);
}

function sessionRow(session, { crossWorkspace = false } = {}) {
  const isWorking = session.status === 'working';
  const subtitleText = crossWorkspace
    ? session.workspaceName
    : `${session.agentType || 'agent'}${session.model ? ` · ${session.model}` : ''}`;
  const meta = node('span', { className: 'row-meta' }, [
    node('span', { text: formatRelative(session.activityAt) }),
    isWorking
      ? node('span', { className: 'status-dot working' })
      : session.unreadCount > 0
        ? node('span', { className: 'badge', text: cappedCount(session.unreadCount) })
        : null,
  ]);
  const control = node('button', {
    className: 'data-row chat-row',
    type: 'button',
    'aria-current': state.route.sessionId === session.id ? 'true' : 'false',
    on: {
      click: async () => {
        if (crossWorkspace && session.workspaceId !== state.route.workspaceId) {
          await loadSessions(session.workspaceId);
        }
        closeOverlay();
        await openSession(session.id, {
          workspaceId: session.workspaceId,
          push: true,
        });
      },
    },
  }, [
    node('span', { className: 'row-monogram', text: initials(session.agentType) }),
    node('span', { className: 'row-copy' }, [
      node('span', { className: 'row-title', text: session.title }),
      node('span', { className: 'row-subtitle', text: subtitleText }),
    ]),
    meta,
  ]);
  return node('li', {}, control);
}

function updateNavSubtitle(element, fallback) {
  const voice = connectionVoice();
  element.className = `nav-subtitle ${voice.className}`;
  element.replaceChildren();
  if (state.connection === 'live') element.textContent = fallback || 'Live';
  else {
    element.append(icon(voice.iconName), document.createTextNode(voice.text));
  }
}

async function openSession(sessionId, { workspaceId = state.route.workspaceId, push = true } = {}) {
  state.route = { view: 'transcript', workspaceId, sessionId };
  persistRoute();
  if (push) history.pushState({ pocketRoute: state.route }, '', '/');
  updateRoutePanels();
  renderWorkspacePanel();
  renderSessionsPanel();
  const cached = await cacheGet(`messages:${sessionId}`);
  if (cached?.messages && !state.messagesBySession.has(sessionId)) {
    state.messagesBySession.set(sessionId, cached.messages);
    state.cursorsBySession.set(sessionId, cached.cursor || 0);
    renderTranscript();
  }
  const composer = state.shell.composer;
  composer.field.value = draftFor(sessionId);
  composer.resize();
  renderComposerState();
  await refreshMessages(sessionId, { full: true });
  state.connectionProbe = null;
  renderTranscript();
}

async function refreshMessages(sessionId, { full = false } = {}) {
  if (!sessionId) return [];
  const cursor = full ? 0 : state.cursorsBySession.get(sessionId) || 0;
  try {
    const data = await request(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?after=${cursor}`,
    );
    const existing = full ? [] : state.messagesBySession.get(sessionId) || [];
    const messages = full ? data.messages : [...existing, ...data.messages];
    state.messagesBySession.set(sessionId, dedupeMessages(messages));
    state.cursorsBySession.set(sessionId, data.cursor);
    const reconciled = reconcileOptimistic(sessionId);
    await cacheSet(`messages:${sessionId}`, {
      cursor: data.cursor,
      messages: state.messagesBySession.get(sessionId).slice(-50),
    });
    if (state.route.sessionId === sessionId) renderTranscript();
    return reconciled;
  } catch (error) {
    handleRuntimeError(error);
    return [];
  }
}

function dedupeMessages(messages) {
  const seen = new Set();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function reconcileOptimistic(sessionId) {
  const result = reconcileDeliveryReceipts(
    state.optimistic,
    sessionId,
    state.cursorsBySession.get(sessionId),
  );
  state.optimistic = result.remaining;
  if (result.reconciled.length > 0) {
    void persistPendingDeliveries();
  }
  return result.reconciled;
}

function currentSession() {
  return sessionsFor(state.route.workspaceId).find(
    (session) => session.id === state.route.sessionId,
  ) || state.recentSessions.find((session) => session.id === state.route.sessionId);
}

function renderTranscript() {
  if (!state.shell) return;
  const session = currentSession();
  const workspace = state.workspaces.find((item) => item.id === state.route.workspaceId);
  const { transcriptNav, transcriptBanner, transcriptScroll, messageList, statusRow } =
    state.shell;
  transcriptNav.heading.textContent = session?.title || 'Transcript';
  updateNavSubtitle(
    transcriptNav.subtitle,
    session?.status === 'working' ? 'Working' : workspace?.name || 'Live',
  );
  renderBanner(transcriptBanner);

  const distanceBefore =
    transcriptScroll.scrollHeight -
    transcriptScroll.clientHeight -
    transcriptScroll.scrollTop;
  const pinned = distanceBefore < 48;
  const messages = [
    ...(state.messagesBySession.get(state.route.sessionId) || []),
    ...state.optimistic.filter((item) => item.sessionId === state.route.sessionId),
  ];
  const toolResults = new Map(
    messages
      .filter((message) => message.kind === 'tool-result' && message.toolCallId)
      .map((message) => [message.toolCallId, message.state]),
  );
  const existingNodes = new Map(
    [...messageList.children].map((element) => [
      element.dataset.messageId,
      element,
    ]),
  );
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    if (message.kind === 'tool-result' || message.kind === 'status') continue;
    const messageId = String(message.id);
    const renderKey = messageRenderKey(message, toolResults);
    let rendered = existingNodes.get(messageId);
    if (!rendered || rendered.__pocketRenderKey !== renderKey) {
      rendered = renderMessage(message, toolResults);
      if (!rendered) continue;
      rendered.dataset.messageId = messageId;
      rendered.__pocketRenderKey = renderKey;
      if (!state.seenMessageIds.has(messageId)) {
        rendered.classList.add('is-new');
        rendered.addEventListener(
          'animationend',
          () => rendered.classList.remove('is-new'),
          { once: true },
        );
      }
    }
    state.seenMessageIds.add(messageId);
    fragment.append(rendered);
  }
  messageList.replaceChildren(fragment);
  renderAgentStatus(statusRow, session);
  requestAnimationFrame(() => {
    if (!state.shell) return;
    if (pinned) {
      transcriptScroll.scrollTo({
        top: transcriptScroll.scrollHeight,
        behavior: 'auto',
      });
    }
    else state.shell.latestButton.hidden = false;
  });
  renderComposerState();
}

function messageRenderKey(message, toolResults) {
  return JSON.stringify([
    message.kind,
    message.text,
    message.delivery,
    message.errorCode,
    message.kind === 'tool'
      ? toolResults.get(message.toolCallId) || message.state
      : message.state,
  ]);
}

function renderBanner(container) {
  container.replaceChildren();
  if (state.connection === 'live') return;
  const down = state.connection === 'offline';
  const banner = node('div', {
    className: `banner ${down ? 'down' : 'wait'}`,
    role: 'status',
  }, [
    icon(down ? 'wifiOff' : 'refresh'),
    node('span', {
      className: 'banner-copy',
      text: down
        ? state.lastHeartbeat
          ? `Mac unreachable · Last synced ${formatTime(state.lastHeartbeat)}`
          : 'Mac unreachable'
        : 'Reconnecting…',
    }),
    node('button', {
      className: 'banner-action',
      type: 'button',
      text: 'Details',
      on: { click: openConnectionSheet },
    }),
  ]);
  container.append(banner);
}

function renderMessage(message, toolResults) {
  if (message.kind === 'assistant') {
    const item = node('li', {
      className: 'message assistant',
      'aria-label': `Conductor replied ${message.text}`,
    });
    item.append(renderRichText(message.text));
    return item;
  }
  if (message.kind === 'user' || message.kind === 'optimistic') {
    const meta = node('div', { className: 'message-meta' });
    if (message.delivery === 'delivering') {
      meta.textContent = 'Delivering…';
    } else if (message.delivery === 'confirming') {
      meta.textContent = 'Checking delivery…';
    } else if (message.delivery === 'failed') {
      meta.classList.add('failed');
      const retrySafe = message.retrySafe === true;
      meta.append(
        icon('warn'),
        document.createTextNode(
          retrySafe ? 'Failed to deliver · ' : 'Delivery unconfirmed · ',
        ),
        node('button', {
          className: 'message-retry',
          type: 'button',
          text: retrySafe ? 'Retry' : 'Check',
          on: {
            click: () =>
              retrySafe ? retryMessage(message) : checkDelivery(message),
          },
        }),
      );
    } else if (
      message.kind === 'optimistic' &&
      message.delivery === 'delivered'
    ) {
      meta.append(
        icon('checkDouble'),
        document.createTextNode('Delivered · Syncing…'),
      );
    } else if (message.queued) {
      meta.textContent = 'Queued';
    } else {
      meta.append(
        icon('checkDouble'),
        document.createTextNode(`Delivered ${formatTime(message.deliveredAt || message.sentAt || message.createdAt)}`),
      );
    }
    return node('li', {
      className: 'message user',
      'aria-label': `You said ${message.text}`,
    }, [
      node('div', { className: 'user-bubble', text: message.text }),
      meta,
    ]);
  }
  if (message.kind === 'tool') {
    const stateValue = toolResults.get(message.toolCallId) || message.state;
    const details = node('details', {
      className: `tool-card ${stateValue === 'failed' ? 'failed' : stateValue === 'running' ? 'running' : ''}`,
    });
    const summary = node('summary', { className: 'tool-summary' }, [
      stateValue === 'running' ? node('span', { className: 'status-dot working' }) : icon('terminal'),
      node('span', { className: 'tool-summary-copy', text: message.name }),
      node('span', {
        className: 'tool-duration',
        text: stateValue === 'running' ? 'running' : stateValue || 'done',
      }),
      icon('chevronDown', 'chevron'),
    ]);
    const detail = node('div', {
      className: 'tool-details',
      text:
        stateValue === 'failed'
          ? 'This action failed. Open Conductor on the Mac for its full output.'
          : 'Full tool inputs and outputs stay on the Mac.',
    });
    details.append(summary, detail);
    return node('li', { className: 'message tool' }, details);
  }
  return null;
}

function renderRichText(text) {
  const fragment = document.createDocumentFragment();
  const sections = String(text).split(/```/);
  sections.forEach((section, index) => {
    if (index % 2 === 1) {
      const firstBreak = section.indexOf('\n');
      const code = firstBreak >= 0 ? section.slice(firstBreak + 1) : section;
      fragment.append(node('pre', {}, node('code', { text: code.trimEnd() })));
      return;
    }
    const paragraphs = section.split(/\n{2,}/);
    for (const paragraph of paragraphs) {
      if (!paragraph.trim()) continue;
      const lines = paragraph.split('\n');
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
        const list = node('ul');
        lines.forEach((line) =>
          list.append(node('li', { text: line.replace(/^\s*[-*]\s+/, '') })),
        );
        fragment.append(list);
      } else {
        fragment.append(node('p', { text: paragraph }));
      }
    }
  });
  return fragment;
}

function renderAgentStatus(container, session) {
  container.replaceChildren();
  container.className = '';
  if (session?.status !== 'working') return;
  container.className = 'status-row';
  container.append(
    node('span', { className: 'status-dot working' }),
    document.createTextNode('Working'),
  );
}

function renderComposerState() {
  if (!state.shell) return;
  const { field, send, reason, draftNote } = state.shell.composer;
  const hasText = field.value.trim().length > 0;
  const down = state.connection === 'offline';
  send.hidden = down;
  reason.hidden = !down;
  if (down) {
    reason.setAttribute('aria-label', "Can't send - Mac unreachable");
    reason.replaceChildren(icon('wifiOff'), document.createTextNode("Can't send"));
  } else {
    reason.removeAttribute('aria-label');
  }
  send.disabled = !hasText;
  send.classList.toggle('unverified', hasText && !state.connectionProbe);
  draftNote.hidden = !(down && hasText);
  draftNote.textContent = down && hasText ? 'Draft saved on this phone' : '';
}

async function sendCurrentMessage() {
  const sessionId = state.route.sessionId;
  const field = state.shell?.composer.field;
  if (!sessionId || !field) return;
  const text = field.value.replace(/\r\n?/g, '\n');
  if (!text.trim() || state.connection === 'offline') return;
  const optimistic = {
    id: `optimistic:${randomIdempotencyKey()}`,
    idempotencyKey: randomIdempotencyKey(),
    kind: 'optimistic',
    sessionId,
    text,
    delivery: 'delivering',
    createdAt: new Date().toISOString(),
  };
  state.optimistic.push(optimistic);
  try {
    await persistPendingDeliveries({ required: true });
  } catch {
    state.optimistic = state.optimistic.filter(
      (item) => item !== optimistic,
    );
    announce('Message stayed in your draft because secure delivery storage was unavailable');
    return;
  }
  field.value = '';
  saveDraft(sessionId, '');
  state.shell.composer.resize();
  renderTranscript();
  await deliverOptimistic(optimistic);
}

async function deliverOptimistic(
  optimistic,
  { replaceDraft = false, expectedMacDraft = optimistic.macDraft } = {},
) {
  optimistic.replaceDraft = replaceDraft;
  if (replaceDraft && !optimistic.replaceIdempotencyKey) {
    optimistic.replaceIdempotencyKey = randomIdempotencyKey();
  }
  const deliveryKey = replaceDraft
    ? optimistic.replaceIdempotencyKey
    : optimistic.idempotencyKey;
  optimistic.activeDeliveryKey = deliveryKey;
  try {
    await persistPendingDeliveries({ required: true });
  } catch {
    optimistic.delivery = 'failed';
    optimistic.errorCode = 'secure_delivery_storage_unavailable';
    optimistic.retrySafe = true;
    renderTranscript();
    return;
  }
  try {
    const result = await fetch(
      `/api/sessions/${encodeURIComponent(optimistic.sessionId)}/messages`,
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': state.csrfToken,
          'Idempotency-Key': deliveryKey,
        },
        body: JSON.stringify({
          message: optimistic.text,
          replaceDraft,
          expectedMacDraft: replaceDraft ? expectedMacDraft : undefined,
        }),
      },
    );
    const payload = await result.json().catch(() => ({}));
    if (!result.ok) {
      const error = new Error(payload.error?.code || `http_${result.status}`);
      error.code = payload.error?.code || `http_${result.status}`;
      error.status = result.status;
      error.draft = payload.error?.draft;
      error.retrySafe = payload.error?.retrySafe === true;
      throw error;
    }
    applyDeliveryReceipt(optimistic, payload);
    await persistPendingDeliveries();
    state.connectionProbe = {
      sendPath: true,
      capabilities: { send: true },
    };
    renderTranscript();
    announce('Message delivered');
    setTimeout(() => refreshMessages(optimistic.sessionId, { full: true }), 120);
  } catch (error) {
    optimistic.errorCode = error.code;
    if (error.code === 'draft_conflict') {
      optimistic.delivery = 'failed';
      optimistic.retrySafe = true;
      await persistPendingDeliveries();
      renderTranscript();
      optimistic.macDraft = error.draft;
      if (replaceDraft) optimistic.replaceIdempotencyKey = null;
      optimistic.replaceDraft = false;
      openDraftConflict(optimistic);
    } else if (error.status === 401 || error.status === 423) {
      optimistic.delivery = 'failed';
      optimistic.retrySafe = false;
      await persistPendingDeliveries();
      renderTranscript();
      handleRuntimeError(error);
    } else if (
      !error.status ||
      error.code === 'send_not_confirmed'
    ) {
      await checkDelivery(optimistic);
    } else {
      optimistic.delivery = 'failed';
      optimistic.retrySafe = error.retrySafe === true;
      await persistPendingDeliveries();
      renderTranscript();
    }
  }
}

function applyDeliveryReceipt(message, receipt) {
  message.delivery = 'delivered';
  message.deliveredAt = receipt.deliveredAt;
  message.receiptBaselineCursor = Number.isSafeInteger(receipt.baselineCursor)
    ? receipt.baselineCursor
    : null;
  message.receiptRowId = Number.isSafeInteger(receipt.rowId)
    ? receipt.rowId
    : null;
  message.retrySafe = false;
}

async function requestDeliveryStatus(message) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DELIVERY_STATUS_REQUEST_MS,
  );
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(message.sessionId)}/delivery-status`,
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'X-CSRF-Token': state.csrfToken,
          'Idempotency-Key':
            message.activeDeliveryKey || message.idempotencyKey,
        },
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        payload.error?.code || `http_${response.status}`,
      );
      error.code = payload.error?.code || `http_${response.status}`;
      error.status = response.status;
      throw error;
    }
    return payload.delivery || { state: 'unknown' };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkDelivery(message) {
  if (!state.optimistic.includes(message)) return true;
  message.delivery = 'confirming';
  message.retrySafe = false;
  await persistPendingDeliveries();
  renderTranscript();
  const deadline = Date.now() + DELIVERY_RECOVERY_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const delivery = await requestDeliveryStatus(message);
      if (delivery.state === 'delivered') {
        applyDeliveryReceipt(message, delivery);
        await persistPendingDeliveries();
        renderTranscript();
        announce('Message delivered');
        await refreshMessages(message.sessionId, { full: true });
        return true;
      }
      if (delivery.state !== 'pending') {
        message.delivery = 'failed';
        message.errorCode =
          delivery.state === 'failed'
            ? delivery.code
            : 'delivery_unknown';
        message.retrySafe =
          delivery.state === 'failed' &&
          delivery.retrySafe === true;
        await persistPendingDeliveries();
        renderTranscript();
        return false;
      }
    } catch (error) {
      lastError = error;
      if (error.status === 401 || error.status === 423) {
        message.delivery = 'failed';
        message.errorCode = error.code;
        message.retrySafe = false;
        await persistPendingDeliveries();
        renderTranscript();
        handleRuntimeError(error);
        return false;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(500, remaining)),
      );
    }
  }
  message.delivery = 'failed';
  message.errorCode = lastError?.code || 'delivery_confirmation_timeout';
  message.retrySafe = false;
  await persistPendingDeliveries();
  renderTranscript();
  return false;
}

async function recoverPendingDeliveries() {
  await Promise.all(
    state.optimistic.map(async (message) => {
      if (message.delivery === 'delivered') {
        await refreshMessages(message.sessionId, { full: true });
      } else if (!(message.delivery === 'failed' && message.retrySafe)) {
        await checkDelivery(message);
      }
    }),
  );
}

function retryMessage(message) {
  if (message.retrySafe !== true) return;
  message.delivery = 'delivering';
  message.retrySafe = false;
  void persistPendingDeliveries();
  renderTranscript();
  deliverOptimistic(message, { replaceDraft: message.replaceDraft === true });
}

function openDraftConflict(message) {
  const content = node('div', {}, [
    node('p', {
      className: 'gate-lede',
      text:
        'The Conductor composer on your Mac already contains unsent text. Pocket did not overwrite it.',
    }),
    node('section', { className: 'pair-card' }, [
      node('div', { className: 'micro-caps', text: 'On your Mac' }),
      node('p', {
        className: 'machine-fact',
        text: message.macDraft || 'Conductor has an unsent draft.',
      }),
      node('div', { className: 'pair-divider' }),
      node('div', { className: 'micro-caps', text: 'From this phone' }),
      node('p', { text: message.text }),
    ]),
    node('button', {
      className: 'primary-button',
      type: 'button',
      text: 'Replace and send',
      on: {
        click: () => {
          message.delivery = 'delivering';
          void persistPendingDeliveries();
          closeOverlay();
          renderTranscript();
          deliverOptimistic(message, {
            replaceDraft: true,
            expectedMacDraft: message.macDraft,
          });
        },
      },
    }),
    node('button', {
      className: 'secondary-button',
      type: 'button',
      text: 'Keep the Mac draft',
      on: {
        click: () => {
          state.shell.composer.field.value = message.text;
          saveDraft(message.sessionId, message.text);
          state.optimistic = state.optimistic.filter((item) => item !== message);
          void persistPendingDeliveries();
          closeOverlay();
          renderTranscript();
        },
      },
    }),
  ]);
  openSheet('Unsent text on your Mac', content);
}

function startEvents() {
  stopEvents();
  const eventSource = new EventSource('/api/events');
  state.eventSource = eventSource;
  const live = () => {
    state.lastHeartbeat = Date.now();
    if (state.connection !== 'live') {
      state.connection = 'live';
      renderConnectionState();
    }
  };
  eventSource.addEventListener('ready', live);
  eventSource.addEventListener('heartbeat', live);
  eventSource.addEventListener('change', async () => {
    live();
    await Promise.all([
      refreshWorkspaces(),
      state.route.workspaceId ? loadSessions(state.route.workspaceId) : Promise.resolve(),
      state.route.sessionId ? refreshMessages(state.route.sessionId) : Promise.resolve(),
    ]);
  });
  eventSource.addEventListener('locked', async (event) => {
    let code = 'device_locked';
    try {
      code = JSON.parse(event.data).code || code;
    } catch {
      // Keep the locked fallback.
    }
    if (code === 'device_revoked' || code === 'authentication_required') {
      await purgeThenRenderSignedOut();
    } else {
      renderLock();
    }
  });
  eventSource.onerror = () => {
    if (Date.now() - state.lastHeartbeat > 10_000) {
      state.connection = state.lastHeartbeat ? 'offline' : 'connecting';
      renderConnectionState();
    }
  };
  state.heartbeatTimer = setInterval(() => {
    if (Date.now() - state.lastHeartbeat > 10_000) {
      state.connection = state.lastHeartbeat ? 'offline' : 'connecting';
      renderConnectionState();
    }
  }, 1_000);
  state.activityTimer = setInterval(() => {
    if (document.hidden || !state.auth || !state.shell) return;
    request('/api/auth/touch', { method: 'POST', body: {}, csrf: true }).catch(
      (error) => {
        if (
          error.status === 401 ||
          error.status === 423 ||
          error.code === 'device_revoked'
        ) {
          handleRuntimeError(error);
        }
      },
    );
  }, ACTIVITY_HEARTBEAT_MS);
}

function stopEvents() {
  state.eventSource?.close();
  state.eventSource = null;
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  if (state.activityTimer) clearInterval(state.activityTimer);
  state.heartbeatTimer = null;
  state.activityTimer = null;
}

function renderConnectionState() {
  renderWorkspacePanel();
  renderSessionsPanel();
  renderTranscript();
}

function handleRuntimeError(error) {
  if (error.status === 401 || error.code === 'device_revoked') {
    void purgeThenRenderSignedOut();
  } else if (error.status === 423 || error.code === 'device_locked') {
    renderLock();
  } else if (error.code === 'retirement_client_upgrade_required') {
    renderConnectionGate(error.code);
  }
}

function openSheet(title, content, { className = '', onClose } = {}) {
  closeOverlay();
  const close = button('Close', {
    iconName: 'close',
    onClick: () => closeOverlay(onClose),
  });
  const sheet = node('section', {
    className: `sheet ${className}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
  }, [
    node('div', { className: 'sheet-grabber', 'aria-hidden': 'true' }),
    node('header', { className: 'sheet-header' }, [
      node('h2', { className: 'sheet-title', text: title }),
      close,
    ]),
    node('div', { className: 'sheet-scroll' }, content),
  ]);
  const overlay = node('div', {
    className: `overlay${className ? ` ${className}-overlay` : ''}`,
    on: {
      pointerdown: (event) => {
        if (event.target === overlay) closeOverlay(onClose);
      },
    },
  }, sheet);
  overlayRoot.replaceChildren(overlay);
  document.addEventListener('keydown', sheetEscape);
  close.focus();
}

function sheetEscape(event) {
  if (event.key === 'Escape') closeOverlay();
}

function closeOverlay(onClose) {
  document.removeEventListener('keydown', sheetEscape);
  overlayRoot.replaceChildren();
  onClose?.();
}

async function openSwitcher() {
  await loadRecentSessions();
  const search = node('input', {
    className: 'search-input',
    type: 'search',
    placeholder: 'Search',
    'aria-label': 'Search recent chats',
  });
  const list = node('ul', { className: 'row-list' });
  const render = () => {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const sessions = state.recentSessions.filter((session) =>
      `${session.title} ${session.workspaceName}`.toLowerCase().includes(query),
    );
    sessions.forEach((session) => list.append(sessionRow(session, { crossWorkspace: true })));
    if (!sessions.length) {
      list.append(
        node('li', { className: 'empty-state' }, [
          node('h2', { text: `No matches for “${search.value.trim()}”` }),
        ]),
      );
    }
  };
  search.addEventListener('input', render);
  render();
  openSheet(
    'Recent chats',
    node('div', {}, [
      node('div', { className: 'search-wrap' }, [icon('search'), search]),
      node('div', { className: 'micro-caps', text: 'Recent' }),
      list,
    ]),
    { className: 'switcher' },
  );
}

async function openConnectionSheet() {
  const startedAt = performance.now();
  const content = node('div', {}, skeletonRows(4));
  openSheet('Connection', content);
  try {
    const probe = await request('/api/connection?force=1');
    state.connectionProbe = probe;
    const latency = Math.round(performance.now() - startedAt);
    const rows = [
      ['Private round trip', state.connection === 'live', `${latency} ms`],
      ['Relay on your Mac', true, probe.relayVersion],
      ['Conductor app', probe.conductor, probe.conductor ? 'Ready' : 'Not ready'],
      ['Accessibility send path', probe.sendPath, probe.sendPath ? 'Verified' : probe.reason],
    ];
    content.replaceChildren();
    rows.forEach(([label, ok, value]) => {
      content.append(
        node('div', { className: 'connection-check' }, [
          ok ? icon('check') : icon('warn'),
          node('span', { text: label }),
          node('span', { className: 'value', text: value }),
        ]),
      );
    });
    content.append(
      node('button', {
        className: 'text-button',
        type: 'button',
        text: 'Run check again',
        on: { click: () => openConnectionSheet() },
      }),
    );
    renderComposerState();
  } catch (error) {
    content.replaceChildren(
      node('div', { className: 'empty-state' }, [
        icon('warn'),
        node('h2', { text: 'The relay check failed' }),
        node('p', { text: 'Confirm Tailscale and the relay are running on your Mac.' }),
      ]),
    );
  }
}

async function openSecurity() {
  const content = node('div', {}, skeletonRows(4));
  openSheet('Security & Devices', content, { className: 'security' });
  try {
    const [devicesResult, connection] = await Promise.all([
      request('/api/devices'),
      request('/api/connection'),
    ]);
    content.replaceChildren();
    const thisPhoneSection = settingsSection('This phone');
    thisPhoneSection.card.append(
      settingsRow({
        iconName: 'phone',
        title: state.auth?.device?.name || 'This iPhone',
        subtitle: `Paired ${formatRelative(state.auth?.device?.createdAt)} · Face ID on`,
      }),
      settingsRow({
        iconName: 'lock',
        title: 'Auto-lock',
        subtitle: 'After 5 minutes away',
      }),
      settingsRow({
        iconName: 'warn',
        title: 'Clear cached transcripts',
        actionLabel: 'Clear',
        destructive: true,
        onAction: confirmClearCache,
      }),
    );
    content.append(thisPhoneSection.root);

    const devicesSection = settingsSection('Paired devices');
    devicesResult.devices.forEach((device) => {
      devicesSection.card.append(
        settingsRow({
          iconName: 'phone',
          title: device.name,
          subtitle: `Last seen ${formatRelative(device.lastSeenAt)} · ${device.tailscaleLogin}`,
          actionLabel:
            device.id === state.auth?.device?.id ? 'Sign out' : 'Revoke',
          destructive: true,
          onAction: () => confirmRevoke(device),
        }),
      );
    });
    content.append(devicesSection.root);

    const connectionSection = settingsSection('Connection');
    connectionSection.card.append(
      settingsRow({
        iconName: connection.sendPath ? 'check' : 'warn',
        title: 'Send path',
        subtitle: connection.sendPath ? 'Verified' : connection.reason || 'Unavailable',
      }),
      settingsRow({
        iconName: 'refresh',
        title: 'Test send path',
        actionLabel: 'Run',
        onAction: openConnectionSheet,
      }),
    );
    content.append(connectionSection.root);

    const appSection = settingsSection('App');
    appSection.card.append(
      settingsRow({
        iconName: 'share',
        title: 'Install on this phone',
        subtitle: isStandalone() ? "Installed - you're running the app" : 'Safari instructions',
        actionLabel: isStandalone() ? null : 'View',
        onAction: isStandalone()
          ? null
          : () => {
              closeOverlay();
              renderInstallGuidance();
            },
      }),
      settingsRow({
        iconName: 'bolt',
        title: 'Conductor Pocket',
        subtitle: `relay ${connection.relayVersion || 'unknown'} · client ${CLIENT_VERSION}`,
      }),
    );
    content.append(appSection.root);
  } catch (error) {
    handleRuntimeError(error);
  }
}

function settingsSection(title) {
  const card = node('div', { className: 'settings-card' });
  return {
    root: node('section', { className: 'settings-section' }, [
      node('h3', { className: 'section-heading', text: title }),
      card,
    ]),
    card,
  };
}

function settingsRow({
  iconName,
  title,
  subtitle,
  actionLabel,
  destructive = false,
  onAction,
}) {
  return node('div', { className: 'settings-row' }, [
    icon(iconName),
    node('div', { className: 'settings-row-copy' }, [
      node('span', { className: 'settings-row-title', text: title }),
      subtitle
        ? node('span', { className: 'settings-row-subtitle', text: subtitle })
        : null,
    ]),
    actionLabel
      ? node('button', {
          className: `settings-row-action${destructive ? ' destructive' : ''}`,
          type: 'button',
          text: actionLabel,
          on: { click: onAction },
        })
      : null,
  ]);
}

function confirmClearCache() {
  openSheet(
    'Clear cached transcripts?',
    node('div', {}, [
      node('p', {
        className: 'gate-lede',
        text: 'Removes transcript copies stored on this phone. Your Mac keeps everything.',
      }),
      node('button', {
        className: 'destructive-button',
        type: 'button',
        text: 'Clear',
        on: {
          click: async () => {
            try {
              await clearTranscriptCache();
              state.messagesBySession.clear();
              closeOverlay();
              await startApplication();
            } catch (error) {
              if (isLocalPurgeFailure(error)) {
                closeOverlay();
                renderLocalPurgeFailure(() => confirmClearCache());
              } else {
                handleRuntimeError(error);
              }
            }
          },
        },
      }),
      node('button', {
        className: 'secondary-button',
        type: 'button',
        text: 'Cancel',
        on: { click: () => closeOverlay() },
      }),
    ]),
  );
}

function confirmRevoke(device) {
  openSheet(
    device.id === state.auth?.device?.id ? 'Sign out this phone?' : `Revoke “${device.name}”?`,
    node('div', {}, [
      node('p', {
        className: 'gate-lede',
        text:
          device.id === state.auth?.device?.id
            ? 'This phone will lose access immediately. Your Mac keeps everything.'
            : `“${device.name}” will be signed out immediately.`,
      }),
      node('button', {
        className: 'destructive-button',
        type: 'button',
        text: device.id === state.auth?.device?.id ? 'Sign out' : 'Revoke',
        on: {
          click: async () => {
            try {
              const currentDevice = device.id === state.auth?.device?.id;
              if (currentDevice) await purgeLocalData();
              const result = await request(
                `/api/devices/${encodeURIComponent(device.id)}/revoke`,
                {
                  method: 'POST',
                  body: currentDevice
                    ? {
                        clientVersion: CLIENT_VERSION,
                        localPurgeCompleted: true,
                      }
                    : {},
                  csrf: true,
                },
              );
              if (result.currentDevice) {
                renderSignedOut();
              } else {
                openSecurity();
              }
            } catch (error) {
              if (
                device.id === state.auth?.device?.id &&
                isLocalPurgeFailure(error)
              ) {
                closeOverlay();
                renderLocalPurgeFailure(() => confirmRevoke(device));
              } else {
                handleRuntimeError(error);
              }
            }
          },
        },
      }),
      node('button', {
        className: 'secondary-button',
        type: 'button',
        text: 'Cancel',
        on: { click: () => closeOverlay() },
      }),
    ]),
  );
}

window.addEventListener('popstate', (event) => {
  if (event.state?.pocketRoute) {
    state.route = event.state.pocketRoute;
    persistRoute();
    updateRoutePanels();
    renderWorkspacePanel();
    renderSessionsPanel();
    if (state.route.sessionId) openSession(state.route.sessionId, { push: false });
  }
});

function shieldApplication() {
  const hiddenAt = Date.now();
  state.hiddenAt = hiddenAt;
  localStorage.setItem(HIDDEN_AT_KEY, String(hiddenAt));
  stopEvents();
  app.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('#privacy-shield')) {
    document.body.append(
      node('div', {
        id: 'privacy-shield',
        className: 'privacy-shield',
        'aria-hidden': 'true',
      }),
    );
  }
}

async function revealApplication() {
  const persistedHiddenAt = Number(localStorage.getItem(HIDDEN_AT_KEY) || 0);
  const hiddenAt = Math.max(state.hiddenAt || 0, persistedHiddenAt);
  const awayTooLong = hiddenAt > 0 && Date.now() - hiddenAt >= AWAY_LOCK_MS;
  localStorage.removeItem(HIDDEN_AT_KEY);
  state.hiddenAt = null;

  if (state.auth && state.shell) {
    if (awayTooLong) {
      await request('/api/auth/lock', {
        method: 'POST',
        body: {},
        csrf: true,
      }).catch(() => {});
      renderLock();
    } else {
      try {
        await request('/api/auth/touch', {
          method: 'POST',
          body: {},
          csrf: true,
        });
        startEvents();
      } catch (error) {
        if (
          error.status === 401 ||
          error.status === 423 ||
          error.code === 'device_revoked'
        ) {
          handleRuntimeError(error);
        } else {
          renderConnectionGate(error.code);
        }
      }
    }
  }

  document.querySelector('#privacy-shield')?.remove();
  app.removeAttribute('aria-hidden');
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) shieldApplication();
  else revealApplication();
});

window.addEventListener('pagehide', shieldApplication);
window.addEventListener('pageshow', () => {
  if (
    !document.hidden &&
    (state.hiddenAt || localStorage.getItem(HIDDEN_AT_KEY))
  ) {
    revealApplication();
  }
});

if ('serviceWorker' in navigator) {
  serviceWorkerRegistrationPromise =
    navigator.serviceWorker.register('/service-worker.js');
  serviceWorkerRegistrationPromise.catch(() => {});
}

const pairingCode = new URLSearchParams(location.hash.slice(1)).get('pair');
if (pairingCode) initializePairing(pairingCode);
else bootstrap();
