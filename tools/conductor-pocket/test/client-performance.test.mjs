import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function applicationSource() {
  return fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
}

function functionSource(source, name, nextName) {
  const start = source.indexOf(`${name}(`);
  const end = source.indexOf(`${nextName}(`, start + name.length);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

function createRevealHarness(source, {
  hiddenAt,
  request,
  handleRuntimeError = () => undefined,
}) {
  let shieldPresent = true;
  let shieldRemovals = 0;
  let appReveals = 0;
  let storedHiddenAt = String(hiddenAt);
  const sandbox = {
    app: {
      removeAttribute() {
        appReveals += 1;
      },
    },
    document: {
      hidden: false,
      querySelector() {
        if (!shieldPresent) return null;
        return {
          remove() {
            shieldPresent = false;
            shieldRemovals += 1;
          },
        };
      },
    },
    handleRuntimeError,
    localStorage: {
      getItem() {
        return storedHiddenAt;
      },
      removeItem() {
        storedHiddenAt = null;
      },
    },
    metadataRefresh: { schedule() {} },
    renderConnectionGate() {},
    renderLock() {},
    request,
    scheduleReadEvaluation() {},
    startEvents() {},
    state: {
      auth: { reauthenticationMode: 'strict' },
      hiddenAt,
      shell: {},
      visibilityEpoch: 1,
    },
    transcriptRefresh: { schedule() {} },
  };
  vm.createContext(sandbox);
  const reveal = functionSource(
    source,
    'async function revealApplication',
    'function currentAppUpdateReloadIsSafe',
  );
  vm.runInContext(
    `const HIDDEN_AT_KEY = 'hidden';
const AWAY_LOCK_MS = 1_000;
const TAILSCALE_SESSION_MODE = 'tailscale-session';
const RESUME_REQUEST_MS = 6_000;
let revealOperationsInFlight = 0;
let revealApplicationPromise = null;
${reveal}
globalThis.__revealApplication = revealApplication;`,
    sandbox,
  );
  return {
    revealApplication: sandbox.__revealApplication,
    result() {
      return { appReveals, shieldRemovals, shieldPresent };
    },
  };
}

test('transient IndexedDB failures and closed handles reopen without a reload', async () => {
  const source = await applicationSource();
  const start = source.indexOf('function invalidateCacheDatabaseConnection');
  const end = source.indexOf("cachePurgeChannel?.addEventListener", start);
  assert.ok(start >= 0, 'cache invalidation helper must exist');
  assert.ok(end > start, 'cache connection helpers must stay together');

  const openRequests = [];
  const sandbox = {
    Error,
    indexedDB: {
      open() {
        const request = {};
        openRequests.push(request);
        return request;
      },
    },
    localStorage: { getItem: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `let cacheDatabasePromise = null;
let cacheDatabaseConnection = null;
let originRetired = false;
const ORIGIN_RETIRED_KEY = 'retired';
${source.slice(start, end)}
globalThis.__cacheDatabase = cacheDatabase;`,
    sandbox,
  );

  const failed = sandbox.__cacheDatabase();
  openRequests[0].error = new Error('transient open failure');
  openRequests[0].onerror();
  await assert.rejects(failed, /transient open failure/);

  const recovered = sandbox.__cacheDatabase();
  assert.equal(openRequests.length, 2);
  const firstDatabase = { close() {} };
  openRequests[1].result = firstDatabase;
  openRequests[1].onsuccess();
  assert.equal(await recovered, firstDatabase);

  firstDatabase.onclose();
  const reopened = sandbox.__cacheDatabase();
  assert.equal(openRequests.length, 3);
  const secondDatabase = { close() {} };
  openRequests[2].result = secondDatabase;
  openRequests[2].onsuccess();
  assert.equal(await reopened, secondDatabase);
});

test('a synchronous IndexedDB open failure does not poison later sends', async () => {
  const source = await applicationSource();
  const start = source.indexOf('function invalidateCacheDatabaseConnection');
  const end = source.indexOf("cachePurgeChannel?.addEventListener", start);
  assert.ok(start >= 0, 'cache invalidation helper must exist');
  assert.ok(end > start, 'cache connection helpers must stay together');

  let openAttempts = 0;
  const openRequests = [];
  const sandbox = {
    Error,
    indexedDB: {
      open() {
        openAttempts += 1;
        if (openAttempts === 1) {
          throw new Error('transient synchronous open failure');
        }
        const request = {};
        openRequests.push(request);
        return request;
      },
    },
    localStorage: { getItem: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `let cacheDatabasePromise = null;
let cacheDatabaseConnection = null;
let originRetired = false;
const ORIGIN_RETIRED_KEY = 'retired';
${source.slice(start, end)}
globalThis.__cacheDatabase = cacheDatabase;`,
    sandbox,
  );

  await assert.rejects(
    sandbox.__cacheDatabase(),
    /transient synchronous open failure/,
  );

  const recovered = sandbox.__cacheDatabase();
  assert.equal(openAttempts, 2, 'the rejected open must not stay memoized');
  const database = { close() {} };
  openRequests[0].result = database;
  openRequests[0].onsuccess();
  assert.equal(await recovered, database);
});

test('warm chat navigation paints before cache or network work', async () => {
  const source = await applicationSource();
  const openSession = functionSource(
    source,
    'async function openSession',
    'async function refreshMessages',
  );

  assert.match(openSession, /state\.sessionOpenController\?\.abort\(\)/);
  assert.match(openSession, /const controller = new AbortController\(\)/);
  const paint = openSession.indexOf('renderTranscript();');
  const cacheRead = openSession.indexOf(
    'cacheGet(`messages:${sessionId}`)',
  );
  const refresh = openSession.indexOf('await refreshMessages');
  assert.ok(paint >= 0);
  assert.ok(cacheRead > paint);
  assert.ok(refresh > paint);
  assert.match(
    openSession,
    /if \(hasMemorySnapshot && hasLiveBaseline\)[\s\S]*refreshMessages\(sessionId, \{[\s\S]*signal: controller\.signal[\s\S]*\}\)[\s\S]*else \{[\s\S]*full: true/,
  );
  assert.match(
    source,
    /full \|\| !state\.messageBaselinesBySession\.has\(sessionId\)/,
  );
});

test('live data paints before noncritical snapshot persistence', async () => {
  const source = await applicationSource();
  const refreshMessages = functionSource(
    source,
    'async function refreshMessages',
    'function dedupeMessages',
  );
  const paint = refreshMessages.indexOf('renderTranscript()');
  const persistence = refreshMessages.indexOf(
    'void cacheSet(`messages:${sessionId}`',
  );

  assert.ok(paint >= 0);
  assert.ok(persistence > paint);
  assert.match(source, /renderWorkspacePanel\(\);\s*void cacheSet\('workspaces'/);
  assert.match(source, /renderSessionsPanel\(\);\s*void cacheSet\(`sessions:/);
});

test('collapsed activity defers hidden Markdown DOM until expansion', async () => {
  const source = await applicationSource();
  const renderActivity = functionSource(
    source,
    'function renderActivity',
    'function renderAgentStatus',
  );

  assert.match(renderActivity, /function populateItems\(\)/);
  assert.match(renderActivity, /if \(expanded\) populateItems\(\)/);
  assert.match(
    renderActivity,
    /if \(nextExpanded\) populateItems\(\)/,
  );
});

test('background failure bursts paint one counted lazy disclosure', async () => {
  const source = await applicationSource();
  const renderTranscript = functionSource(
    source,
    'function renderTranscript',
    'function isMessageContinuation',
  );
  const renderKey = functionSource(
    source,
    'function messageRenderKey',
    'function renderBanner',
  );
  const renderMessage = functionSource(
    source,
    'function renderMessage',
    'function renderActivity',
  );
  const renderActivity = functionSource(
    source,
    'function renderActivity',
    'function renderAgentStatus',
  );

  assert.match(renderKey, /message\.backgroundErrorCount[\s\S]*expanded/);
  assert.match(renderKey, /item\.occurrenceCount/);
  assert.match(
    renderTranscript,
    /announcementId = `\$\{messageId\}:background-errors`[\s\S]*seenMessageIds\.add\(announcementId\)/,
  );
  assert.match(
    renderMessage,
    /occurrenceCount > 1[\s\S]*background actions failed[\s\S]*private action details/,
  );
  assert.match(renderActivity, /hasErrors[\s\S]*icon\('warn'\)/);
  assert.match(renderActivity, /if \(expanded\) populateItems\(\)/);
});

test('streaming transcript and metadata refresh on separate schedules', async () => {
  const source = await applicationSource();
  assert.match(
    source,
    /const transcriptRefresh = createLiveRefreshCoordinator\(\{[\s\S]*delayMs: LIVE_REFRESH_DEBOUNCE_MS/,
  );
  assert.match(
    source,
    /const metadataRefresh = createLiveRefreshCoordinator\(\{[\s\S]*delayMs: METADATA_REFRESH_DEBOUNCE_MS/,
  );
  assert.match(
    source,
    /eventSource\.addEventListener\('change'[\s\S]*transcriptRefresh\.schedule\(\)[\s\S]*metadataRefresh\.schedule\(\)/,
  );
});

test('chat UI styles do not hijack the app’s existing rows', async () => {
  const [css, js] = await Promise.all([
    fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  // Every session row in the switcher and the sessions panel carries
  // "data-row chat-row". A bare .chat-row rule therefore restyles all of them,
  // which is what left Recent chats with a right-aligned title and a floating
  // timestamp. Sheet-specific styling must stay namespaced.
  assert.match(js, /className: 'data-row chat-row'/);
  assert.doesNotMatch(css, /^\.chat-row\s*\{/m);
  assert.doesNotMatch(css, /^\.chat-row\.is-active\s*\{/m);
  assert.match(css, /^\.chats-sheet-row\s*\{/m);

  // The strip is a flex child of a column panel whose scroll area grows, so it
  // must refuse to shrink or the chips render clipped at half height.
  const strip = css.slice(css.indexOf('.chat-strip {'));
  assert.match(strip.slice(0, strip.indexOf('}')), /flex:\s*0\s+0\s+auto/);
});

test('the chat strip never scrolls the transcript', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const start = js.indexOf('function renderChatStrip()');
  const body = js.slice(start, js.indexOf('\n}\n', start));
  // scrollIntoView walks ancestors, so calling it on a chip scrolls the
  // transcript. This runs on every transcript render, which reads as the screen
  // jumping to the top mid-conversation.
  assert.doesNotMatch(body, /scrollIntoView\(/);
  assert.match(body, /strip\.scrollLeft = /);
  // Recentring on every render would fight a manual scroll of the strip.
  assert.match(body, /lastCentredSessionId !== state\.route\.sessionId/);
});


test('closing a chat is never an inline second tap', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  // An armed control that appears where the first tap landed can be
  // double-tapped by accident, and on a scrolling list the row can move under
  // the finger between taps. Confirmation must be its own sheet.
  assert.match(js, /function confirmCloseChat\(/);
  assert.match(js, /openSheet\(\s*'Close this chat\?'/);
  // The chat is named, so the destructive choice cannot be ambiguous.
  assert.match(js, /className: 'confirm-target'[\s\S]*text: session\.title/);
  // Keep is offered before Close, and Close is the only path that confirms.
  const keep = js.indexOf("text: 'Keep it'");
  const shut = js.indexOf("text: 'Close it'");
  assert.ok(keep >= 0 && shut > keep);
  assert.match(js, /text: 'Close it'[\s\S]*confirm: true/);
  // No armed-in-place state may return.
  assert.doesNotMatch(js, /is-armed/);
});

test('chat strip separates working from finished unread with no extra work', async () => {
  const [js, css] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  // Status must come from the session rows already in memory. A dedicated fetch
  // or timer here would put a poll behind every chip.
  const start = js.indexOf('function renderChatStrip()');
  const body = js.slice(start, js.indexOf('\n}\n', start));
  assert.match(body, /STRIP_STATUS\[session\.status\]/);
  assert.doesNotMatch(body, /fetch\(|setInterval\(|request\(/);
  // idle must render nothing, or a dot stops meaning anything.
  assert.doesNotMatch(js, /STRIP_STATUS = \{[\s\S]*\bidle:/);
  // Working owns the indicator until it finishes. Only then can the existing
  // effective unread count become the static ready-to-read number.
  assert.match(body, /unreadCount: sessionUnreadCount\(session\)/);
  assert.match(body, /const unread = !state_ && unreadCount > 0;/);
  assert.match(body, /className: 'chip-unread'/);
  assert.match(body, /text: cappedCount\(unreadCount\)/);
  assert.match(body, /reply ready, \$\{unreadCount\} unread/);
  // The render key includes effective unread state so a durable read receipt
  // removes the number without waiting for unrelated session metadata.
  assert.match(body, /sessionUnreadCount\(session\)/);
  assert.match(
    js,
    /readReceiptChannel\?\.postMessage[\s\S]*renderChatStrip\(\)[\s\S]*readReceiptChannel\?\.addEventListener[\s\S]*renderChatStrip\(\)/,
  );
  // One compositor-friendly opacity pulse is the only motion. It has no JS
  // timer and Reduced Motion explicitly disables it.
  assert.match(css, /\.chip-dot\.is-working \{[\s\S]*animation: working-pulse/);
  assert.match(
    css,
    /\.chat-chip\.is-active \.chip-dot\.is-working \{[\s\S]*color: var\(--on-copper\)/,
    'the current working chat must not paint its dot into the active chip background',
  );
  assert.match(css, /\.chip-unread \{/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.chip-dot\.is-working[\s\S]*animation: none !important/,
  );
  assert.doesNotMatch(body, /status-dot/);
  // The meaning has to reach screen readers, not just sighted users.
  assert.match(body, /aria-label[\s\S]*state_\.label[\s\S]*reply ready/);
});

test('cross-repository chat controls always show repository and workspace context', async () => {
  const js = await applicationSource();
  assert.match(js, /function sessionLocationLabel\(session\)/);
  assert.match(
    js,
    /session\.repositoryName[\s\S]*session\.workspaceName/,
  );
  assert.match(
    js,
    /if \(workspace\) workspace\.textContent = sessionLocationLabel\(session\)/,
  );
  assert.match(
    js,
    /const subtitleText = crossWorkspace[\s\S]*sessionLocationLabel\(session\)/,
  );
});

test('the header reports the current chat’s state, including waiting', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  // needs_plan_response used to fall through to the workspace name, hiding the
  // one state that is blocked on the operator.
  assert.match(js, /needs_plan_response'\s*\?\s*'Waiting for you'/);
  // The header marker reuses the strip's still dot, never the pulsing one.
  assert.match(js, /transcriptNav\.subtitle\.prepend\(/);
  assert.match(js, /className: `chip-dot \$\{headerStatus\.dot\}`/);
  // During a connection problem the subtitle describes the connection, so the
  // chat marker must not be layered on top of it.
  assert.match(js, /state\.connection === 'live' && headerStatus/);
});

test('the app can never be left blank, and reading position survives a render', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  // Revealing must never be conditional on a reload that may not land. That
  // left the privacy shield over the app until it was force-quit.
  assert.doesNotMatch(js, /if \(!appUpdateCoordinator\?\.foreground\(\)\) revealApplication\(\)/);
  assert.match(js, /appUpdateCoordinator\?\.foreground\(\);\s*\n\s*revealApplication\(\);/);
  // A visible page with a shield over it must retry the authenticated reveal.
  // The failsafe must never expose a transcript while that request is pending.
  assert.match(js, /function ensureNotShielded\(\)/);
  const failsafe = functionSource(
    js,
    'function ensureNotShielded',
    'async function revealApplication',
  );
  assert.match(failsafe, /revealOperationsInFlight > 0/);
  assert.match(failsafe, /revealApplication\(\)\.catch/);
  assert.doesNotMatch(failsafe, /shield\.remove\(\)/);
  const reveal = functionSource(
    js,
    'async function revealApplication',
    'function currentAppUpdateReloadIsSafe',
  );
  assert.match(reveal, /revealOperationsInFlight \+= 1;[\s\S]*try \{/);
  assert.match(
    reveal,
    /finally \{[\s\S]*revealOperationsInFlight -= 1;/,
  );
  // The transcript is fully rebuilt each render. New rows belong below an
  // unpinned reader, so the exact visible reading position must stay put.
  assert.match(js, /const scrollTopBefore = transcriptScroll\.scrollTop/);
  assert.match(
    js,
    /transcriptScroll\.scrollTop = Math\.max\(0, scrollTopBefore\)/,
  );
});

test('the privacy shield fails closed when WebKit storage is unavailable', async () => {
  const source = await applicationSource();
  const shield = functionSource(
    source,
    'function shieldApplication',
    'function ensureNotShielded',
  );
  const stopEventsAt = shield.indexOf('stopEvents();');
  const hideAt = shield.indexOf("app.setAttribute('aria-hidden', 'true')");
  const insertAt = shield.indexOf("id: 'privacy-shield'");
  const storageAt = shield.indexOf('localStorage.setItem');
  assert.ok(stopEventsAt >= 0 && stopEventsAt < storageAt);
  assert.ok(hideAt >= 0 && hideAt < storageAt);
  assert.ok(insertAt >= 0 && insertAt < storageAt);
  assert.match(
    shield,
    /try \{[\s\S]*localStorage\.setItem[\s\S]*\} catch \{[\s\S]*shield already protects/,
  );
});

test('resume reveal is single-flight and waits for revoked-device purge', async () => {
  const source = await applicationSource();
  let releaseLock;
  const lockGate = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const requests = [];
  const singleFlight = createRevealHarness(source, {
    hiddenAt: Date.now() - 2_000,
    request(pathname) {
      requests.push(pathname);
      return pathname === '/api/auth/lock'
        ? lockGate
        : Promise.resolve({});
    },
  });

  const firstReveal = singleFlight.revealApplication();
  const secondReveal = singleFlight.revealApplication();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(requests, ['/api/auth/lock']);
  assert.deepEqual(singleFlight.result(), {
    appReveals: 0,
    shieldRemovals: 0,
    shieldPresent: true,
  });
  releaseLock({});
  await Promise.all([firstReveal, secondReveal]);
  assert.equal(singleFlight.result().shieldRemovals, 1);

  let releasePurge;
  const purgeGate = new Promise((resolve) => {
    releasePurge = resolve;
  });
  const revoked = createRevealHarness(source, {
    hiddenAt: Date.now(),
    request() {
      return Promise.reject({ status: 401, code: 'device_revoked' });
    },
    handleRuntimeError() {
      return purgeGate;
    },
  });
  const revokedReveal = revoked.revealApplication();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(revoked.result(), {
    appReveals: 0,
    shieldRemovals: 0,
    shieldPresent: true,
  });
  releasePurge();
  await revokedReveal;
  assert.equal(revoked.result().shieldRemovals, 1);
});

test('feedback reaches a sighted user, and retry never fails silently', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const html = await fs.readFile(
    new URL('../public/index.html', import.meta.url),
    'utf8',
  );

  // Everything the app says went only to an sr-only aria-live region, so a
  // success and a failure looked identical on a phone: nothing moved. That is
  // why a slow operation read as broken and got tapped again.
  assert.match(html, /id="toast"/);
  const announceStart = js.indexOf('function announce(message)');
  assert.ok(announceStart > 0, 'announce must exist');
  const announceBody = js.slice(announceStart, js.indexOf('\n}\n', announceStart));
  assert.match(announceBody, /announcer\.textContent/);
  assert.match(announceBody, /toastElement/);

  // Tapping Retry used to be able to do nothing at all: three separate gates
  // returned with no message. Every early exit must say something.
  const retryStart = js.indexOf('async function retryMessage(message)');
  assert.ok(retryStart > 0, 'retryMessage must exist');
  const retryBody = js.slice(retryStart, js.indexOf('\n}\n', retryStart));
  assert.doesNotMatch(
    retryBody,
    /if \(!deliveryCanRetry\(message\)\) return;/,
    'a retry gate must not return without telling the operator why',
  );

  // Creating a chat is a multi-second Mac round trip. Without a single-flight
  // guard a second tap posts a second shortcut and creates a second chat.
  assert.match(js, /chatCreationInFlight/);
  const createStart = js.indexOf('async function createChat(');
  const createBody = js.slice(createStart, js.indexOf('\n}\n', createStart));
  assert.match(createBody, /if \(chatCreationInFlight\) return null;/);
  assert.match(createBody, /aria-busy/);
})

test('new chat uses the selected repository even when no chat is open', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const createStart = js.indexOf('async function runCreateChat(');
  const createEnd = js.indexOf('\n}\n', createStart);
  const createBody = js.slice(createStart, createEnd);

  assert.match(createBody, /await loadSessions\(workspaceId\)/);
  assert.match(createBody, /sessionsFor\(workspaceId\)/);
  assert.match(
    createBody,
    /runTabAction\('new', \{ sessionId: anchorSessionId \}\)/,
  );
});

test('checking delivery exposes a safe way back to terminal actions', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  assert.match(js, /async function stopCheckingDelivery\(message\)/);
  assert.match(
    js,
    /message\.delivery === 'confirming'[\s\S]{0,500}text: 'Stop checking'/,
  );
  assert.match(
    js,
    /type: 'stop-check'[\s\S]{0,800}applyAuthoritativePendingDelivery/,
  );
});

test('a rejected stale steer is terminal and never shown as delivery unknown', async () => {
  const js = await applicationSource();
  assert.match(
    js,
    /conductor_turn_rejected: 'Conductor rejected this message because the chat no longer has an active turn\.'/,
  );
  assert.match(js, /error\.final = payload\.error\?\.final === true/);
  assert.match(
    js,
    /else if \(error\.final === true\)[\s\S]*delivery = 'failed'[\s\S]*deliveryRecoveryExhausted = true/,
  );
  assert.match(
    js,
    /message\.errorCode === 'conductor_turn_rejected'[\s\S]*'Rejected'/,
  );
});

test('a canceled confirmed row stays actionable instead of disappearing', async () => {
  const js = await applicationSource();
  assert.match(
    js,
    /conductor_message_cancelled: 'Conductor canceled this message after it entered the chat\.'/,
  );
  assert.match(
    js,
    /knownTerminalFailure =[\s\S]*conductor_message_cancelled/,
  );
  assert.match(
    js,
    /receiptMessageId:[\s\S]*value\.receiptMessageId/,
  );
  assert.match(
    js,
    /function reconcileOptimistic[\s\S]*result\.missing[\s\S]*verifyMissingDeliveryReceipt/,
  );
});

test('the composer growing a line does not move the transcript under the reader', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );

  // The textarea was sized by newline count, so a long line that soft-wrapped
  // still reported one row. Pressing Enter grew it correctly and wrapping did
  // not, which is exactly why the jump happened sometimes and not others.
  assert.doesNotMatch(
    js,
    /field\.rows = Math\.max\(1, Math\.min\(6, field\.value\.split\('\\n'\)\.length\)\)/,
    'composer rows must account for soft wrapping, not just newlines',
  );
  const resizeStart = js.indexOf('const resize = () => {');
  assert.ok(resizeStart > 0, 'composer resize must exist');
  const resizeBody = js.slice(resizeStart, js.indexOf('\n  };', resizeStart));
  assert.match(resizeBody, /scrollHeight/);
  assert.match(resizeBody, /lineHeight/);

  // The transcript is sized off --composer-height, so a taller composer shrinks
  // it. Without compensation the text under the reader's eye shifts by exactly
  // one line every time the composer grows.
  const observerStart = js.indexOf('let lastComposerHeight = 0;');
  assert.ok(observerStart > 0, 'composer height must be tracked across resizes');
  const observerBody = js.slice(observerStart, js.indexOf('observer.observe(root);', observerStart));
  assert.match(observerBody, /transcriptScroll/);
  assert.match(observerBody, /wasPinned/);
  // Position must be read BEFORE the variable is written, or it measures the
  // layout it is trying to correct for.
  assert.ok(
    observerBody.indexOf('wasPinned') <
      observerBody.indexOf("setProperty(\n      '--composer-height'"),
    'scroll position must be measured before --composer-height changes',
  );
});

test('opening a chat lands on the newest message, not the last chat position', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );

  // Opening a chat has no scroll-to-bottom of its own; it relies entirely on
  // the pinned check. That check is measured BEFORE the list is replaced, so it
  // reads the previous chat's content and scroll position. Scrolled up in one
  // chat, open another, and that distance from the end is restored against the
  // new chat, leaving the newest message off screen.
  assert.match(js, /let lastTranscriptSessionId = null;/);
  assert.match(js, /const transcriptSessionChanged =\s*\n?\s*lastTranscriptSessionId !== state\.route\.sessionId;/);

  // A hidden or backgrounded scroller reports clientHeight 0, which inflates
  // the measured distance by exactly one viewport and scrolls a screen too high
  // when restored.
  assert.match(js, /const measurable = transcriptScroll\.clientHeight > 0;/);

  const pinnedMatch = js.match(/const pinned =\s*\n?\s*([^;]+);/);
  assert.ok(pinnedMatch, 'pinned must be derived');
  const pinnedExpression = pinnedMatch[1];
  assert.match(pinnedExpression, /transcriptSessionChanged/);
  assert.match(pinnedExpression, /!measurable/);
  assert.match(pinnedExpression, /distanceBefore < 48/);
});

test('returning to the app follows the newest message until moved by hand', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );

  // A chat's messages arrive in two passes, a memory snapshot then the network
  // refresh, and coming back to the app re-runs that. The first paint can hold
  // a fraction of the messages, so every message landing afterwards is inserted
  // ABOVE the reader. Measuring distance-from-bottom on that partial paint and
  // then preserving it is what left the view stranded far up the page.
  assert.match(js, /let transcriptMovedByHand = false;/);

  // The signal must be a real gesture, never a programmatic scroll, or the
  // app's own scroll writes would immediately clear it.
  const gestureStart = js.indexOf('function noteReadGesture()');
  assert.ok(gestureStart > 0, 'noteReadGesture must exist');
  const gestureBody = js.slice(gestureStart, js.indexOf('\n}\n', gestureStart));
  assert.match(gestureBody, /transcriptMovedByHand = true;/);

  // Opening a different chat starts untouched again, so one chat's reading
  // position can never be applied to another.
  assert.match(js, /if \(transcriptSessionChanged\) transcriptMovedByHand = false;/);

  const pinnedMatch = js.match(/const pinned =\s*\n?\s*([^;]+);/);
  assert.ok(pinnedMatch, 'pinned must be derived');
  assert.match(pinnedMatch[1], /!transcriptMovedByHand/);
  // The deliberate preservation case survives: a reader who HAS scrolled keeps
  // their distance from the end while messages stream in.
  assert.match(pinnedMatch[1], /distanceBefore < 48/);
})

test('the composer growing corrects scroll in the same frame it paints', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );

  // A ResizeObserver callback runs after layout but BEFORE paint, so a scroll
  // written there lands in the same frame as the taller composer. Deferring it
  // into a requestAnimationFrame meant the browser first painted the grown dock
  // over the last message and only then snapped the scroll: a visible flicker
  // on every line wrap, which is the thing this handler exists to prevent.
  const start = js.indexOf('let lastComposerHeight = 0;');
  assert.ok(start > 0, 'composer height tracking must exist');
  const body = js.slice(start, js.indexOf('observer.observe(root);', start));
  assert.match(body, /scroller\.scrollTop = scroller\.scrollHeight;/);
  // The CALL form, so the word may still appear in the comment explaining why
  // it must not be used here.
  assert.doesNotMatch(
    body,
    /requestAnimationFrame\(/,
    'the correction must not be deferred a frame, that is the flicker',
  );

  // And it must stay conditional: a reader who is not at the bottom needs no
  // correction at all, because the dock is out of flow and nothing they can see
  // moved.
  assert.match(body, /!wasPinned\) return;/);
})

test('the composer shrinking after send stays pinned in the same frame', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const start = js.indexOf('let lastComposerHeight = 0;');
  assert.ok(start > 0, 'composer height tracking must exist');
  const body = js.slice(start, js.indexOf('observer.observe(root);', start));

  assert.doesNotMatch(
    body,
    /delta\s*<=\s*0/,
    'a send collapse must re-pin before the smaller dock is painted',
  );
  assert.match(body, /if \(!scroller \|\| !wasPinned\) return;/);
  assert.match(body, /scroller\.scrollTop = scroller\.scrollHeight;/);
})

test('the next message can queue before the prior delivery finishes', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const start = js.indexOf('async function sendCurrentMessage');
  const end = js.indexOf('function restoredAttachmentItems', start);
  const body = js.slice(start, end);
  const release = body.lastIndexOf('state.sendInFlight.delete(sessionId);');
  const delivery = body.indexOf(
    'await deliverOptimistic(optimistic, { deliveryIdentityPersisted: true });',
  );

  assert.ok(release >= 0, 'the composer send gate must be released');
  assert.ok(delivery > release, 'delivery must begin after the composer is released');
})

test('no scroll correction is ever deferred a frame', async () => {
  // The house rule, because this class of bug came back four separate times:
  // a corrective scroll must be written in the SAME frame as the mutation that
  // caused it. Deferring one into a requestAnimationFrame paints the old
  // position first and then snaps, which is the jumping and flickering seen
  // while typing and while messages stream in. Reading scrollHeight forces the
  // layout the correction needs, so there is nothing to wait for.
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const offsets = [];
  let index = js.indexOf('requestAnimationFrame(');
  while (index !== -1) {
    offsets.push(index);
    index = js.indexOf('requestAnimationFrame(', index + 1);
  }
  assert.ok(offsets.length > 0, 'the file should still use rAF for non-layout work');
  for (const offset of offsets) {
    // The callback body, bounded generously: any scroll write near an rAF is
    // worth failing on and re-checking by hand.
    const body = js.slice(offset, offset + 600);
    assert.doesNotMatch(
      body,
      /scrollTop\s*=|scrollTo\(|scrollIntoView\(/,
      `a scroll correction is deferred inside a requestAnimationFrame near offset ${offset}`,
    );
  }
})

test('account usage is reachable when nothing is wrong', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  // The Connection sheet holds the seat usage, and it used to be reachable ONLY
  // from the offline banner and a button hidden unless the Mac was down. So the
  // one question it answers, "am I actually out of usage", could not be asked
  // while the app looked healthy, which is exactly when it gets asked.
  assert.match(
    js,
    /const connection = node\('button', \{\s*\n\s*className: 'connection-voice'/,
    'the always-visible connection line must be the way in',
  );
  assert.match(js, /'aria-label': 'Connection and account usage'/);

  // One promise owns the cache, request coalescing, and freshness window. A
  // force tap during the first read joins that request instead of claiming
  // usage is unavailable.
  assert.match(js, /const seatUsageReader = createUsageReader\(\{/);
  const refreshStart = js.indexOf('async function refreshSeatUsage(');
  const refreshBody = js.slice(refreshStart, js.indexOf('\n}\n', refreshStart));
  assert.match(refreshBody, /seatUsageReader\.read\(\{ force \}\)/);
  assert.match(js, /return activeGptUsage\(seatUsageCache\);/);

  // Both windows feed the glanceable number, because either alone can stop a
  // turn and a seat routinely sits near zero on one while the other is spent.
  const voiceStart = js.indexOf('function renderConnectionVoice(container)');
  const voiceBody = js.slice(voiceStart, js.indexOf('\n}\n', voiceStart));
  assert.match(voiceBody, /weeklyPercent/);
  assert.match(voiceBody, /fiveHourPercent/);
  assert.match(voiceBody, /Math\.max/);
})

test('leaving a chat and coming back keeps the reading position', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const css = await fs.readFile(
    new URL('../public/app.css', import.meta.url),
    'utf8',
  );

  // Panels are toggled with display:none, and the browser DISCARDS the scroll
  // position of anything display:none. So going to Workspaces and back always
  // returned the transcript to the top, and no amount of correcting WHEN the
  // app writes scroll could fix it, because the app was not doing the
  // resetting. This was the jump that survived every other fix.
  assert.match(css, /\.panel \{[\s\S]*?display: none;/);
  assert.match(js, /let transcriptHiddenScrollTop = null;/);

  const updateStart = js.indexOf('function updateRoutePanels()');
  assert.ok(updateStart > 0, 'updateRoutePanels must exist');
  const updateBody = js.slice(updateStart, js.indexOf('\n}\n', updateStart));

  // Captured BEFORE the class flips, or the position is already gone.
  const capture = updateBody.indexOf('transcriptHiddenScrollTop = scroller.scrollTop');
  const flip = updateBody.indexOf("classList.toggle('is-active', view === 'transcript')");
  assert.ok(capture > 0 && flip > 0 && capture < flip, 'anchor must be captured before the panel is hidden');

  // New rows append below the reader, so returning keeps the exact visible
  // reading position instead of pulling the transcript toward the end.
  assert.match(updateBody, /scroller\.scrollTop = Math\.max\(0, transcriptHiddenScrollTop\)/);
  // Same-frame, like every other correction in this file.
  assert.doesNotMatch(updateBody, /requestAnimationFrame\(/);
})

test('the phone UI holds still: keyboard, list rebuilds, sheets, offline churn', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  // THE KEYBOARD SHIFT. index.html asks for interactive-widget=resizes-content
  // and WebKit does not implement it, so iOS shrinks only the VISUAL viewport.
  // The shell stays full screen height, the composer's bottom:0 sits behind the
  // keyboard, and WebKit drags the whole app up to reveal the caret. The app
  // must give up that space itself.
  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(js, /function syncKeyboardInset\(\)/);
  assert.match(js, /window\.visualViewport\.addEventListener\('resize', syncKeyboardInset\)/);
  assert.match(js, /window\.visualViewport\.addEventListener\('scroll', syncKeyboardInset\)/);
  // Dismissing must always restore it, even if a resize event is missed.
  assert.match(js, /addEventListener\('focusout'/);
  assert.match(css, /height: calc\(100% - var\(--keyboard-inset, 0px\)\)/);

  // The workspaces rebuild swaps the scroll container itself, on an 8s poll and
  // every stream event, so the list snapped to the top by itself and the search
  // input was destroyed mid-word.
  const wsStart = js.indexOf('const previousContent = panel.querySelector');
  assert.ok(wsStart > 0, 'workspace rebuild must preserve scroll and caret');
  const wsBody = js.slice(wsStart, wsStart + 1200);
  assert.match(wsBody, /restoredContent\.scrollTop = previousScrollTop/);
  assert.match(wsBody, /restoredSearch\.focus\(\{ preventScroll: true \}\)/);
  assert.match(wsBody, /setSelectionRange\(selectionStart, selectionEnd\)/);

  // Sheets: .sheet sets max-height but no height, so a percentage max-height on
  // the scroller resolved to none and overflow:hidden clipped instead. Long
  // lists were unreachable. A flex column with min-height:0 works either way.
  const sheetRule = css.slice(css.indexOf('.sheet {'), css.indexOf('.sheet-grabber'));
  assert.match(sheetRule, /display: flex;/);
  assert.match(sheetRule, /flex-direction: column;/);
  const scrollRule = css.slice(css.indexOf('.sheet-scroll {'), css.indexOf('.sheet-scroll {') + 220);
  assert.match(scrollRule, /min-height: 0;/);
  assert.match(scrollRule, /flex: 1 1 auto;/);
  assert.doesNotMatch(scrollRule, /max-height: calc\(100% - 56px\)/);

  // Offline churn: renderConnectionState rebuilds all three panels, and it ran
  // every second while the Mac was unreachable, so the banner's Details button
  // was a new node under the finger each tick.
  assert.match(js, /const connectionChanged = state\.connection !== nextConnection;/);
  assert.match(js, /if \(connectionChanged\) renderConnectionState\(\);/);

  // Signing out must not leave its confirmation sheet on top of the gate.
  const signOut = js.slice(
    js.indexOf("closeOverlay({ immediate: true });\n                renderSignedOut();") - 40,
  );
  assert.match(
    signOut.slice(0, 240),
    /closeOverlay\(\{ immediate: true \}\);\s*\n\s*renderSignedOut\(\);/,
  );

  // Landscape: every iPhone is past the two-column breakpoint when rotated, so
  // the left column sat under the notch.
  assert.match(css, /max\(4px, env\(safe-area-inset-left\)\)/);
})

test('all-account usage is a visible phone control inside every chat', async () => {
  const [js, css, usageState] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/usage-state.js', import.meta.url), 'utf8'),
  ]);

  // Usage first landed behind the Chats sheet. A control that has to be
  // explained is not visible, so the transcript header must name it directly.
  const navStart = js.indexOf('function createPanelNav(');
  assert.ok(navStart > 0, 'createPanelNav must exist');
  const navBody = js.slice(navStart, js.indexOf('\n}\n', navStart));
  assert.match(navBody, /onUsage/);
  assert.match(navBody, /button\('Usage'/);
  assert.match(navBody, /className: 'usage-nav-button'/);
  assert.match(js, /onUsage: openUsageSheet/);
  assert.match(css, /\.usage-nav-button[\s\S]*min-height: 44px/);

  // Mountable without awaiting, so placing it cannot block a sheet from
  // opening if the producer is slow or down.
  assert.match(js, /function accountUsageSection\(\{ force = false \} = \{\}\)/);
  const sectionStart = js.indexOf('function accountUsageSection(');
  const sectionBody = js.slice(sectionStart, js.indexOf('\n}\n', sectionStart));
  assert.match(sectionBody, /void fillAccountUsage\(section, \{ force \}\)/);
  assert.match(sectionBody, /return section;/);

  // One sheet, grouped by provider. No provider failure can hide the other.
  assert.match(js, /function openUsageSheet\(\)/);
  assert.match(js, /usage\.providers/);
  assert.match(js, /usage-provider-heading/);
  assert.match(js, /provider\.available/);
  assert.match(js, /usageAccountStatus\(account\)/);
  assert.match(
    usageState,
    /if \(account\.stale && parts\.length > 0\) parts\.push\('cached'\)/,
    'an account without usage must say No data yet, not only cached',
  );
  assert.match(usageState, /account\.needsLogin[\s\S]*Needs sign-in/);

  // And the Workspaces header entry point stays.
  assert.match(js, /'aria-label': 'Connection and account usage'/);
})

test('phone controls keep full touch targets and usage rows stack before they collide', async () => {
  const css = await fs.readFile(
    new URL('../public/app.css', import.meta.url),
    'utf8',
  );

  const latestRule = css.slice(
    css.indexOf('.latest-button {'),
    css.indexOf('.latest-button[hidden]'),
  );
  const chatChipRule = css.slice(
    css.indexOf('.chat-chip {'),
    css.indexOf('.chat-chip.is-active'),
  );
  const newChatRule = css.slice(
    css.indexOf('.chat-chip.is-new {'),
    css.indexOf('.chip-dot'),
  );

  assert.match(latestRule, /min-height: 44px;/);
  assert.match(chatChipRule, /min-height: 44px;/);
  assert.match(newChatRule, /min-width: 44px;/);
  assert.match(
    css,
    /@media \(max-width: 430px\) \{[\s\S]*?\.usage-seat \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?\.usage-seat-value \{[\s\S]*?text-align: left;[\s\S]*?\.usage-seat-reset \{[\s\S]*?margin-top: 0;/,
  );
});

test('sheets enter at final geometry and finish one bounded exit', async () => {
  const [js, css] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);

  assert.match(css, /--motion-overlay-enter: 220ms;/);
  assert.match(css, /--motion-overlay-exit: 160ms;/);
  assert.match(css, /\.sheet\.usage \{[\s\S]*?height: min\(75%, 640px\);/);
  assert.match(css, /\.overlay::before \{[\s\S]*?animation: scrim-in/);
  assert.match(css, /\.overlay\.is-closing::before \{[\s\S]*?animation: scrim-out/);
  assert.match(css, /\.overlay\.is-closing \.sheet \{[\s\S]*?animation: sheet-out/);

  const openStart = js.indexOf('async function openSheet(');
  const closeStart = js.indexOf('async function closeOverlay(');
  assert.ok(openStart > 0 && closeStart > openStart);
  const openBody = js.slice(openStart, closeStart);
  const closeBody = js.slice(closeStart, js.indexOf('\nasync function openSwitcher', closeStart));
  assert.match(openBody, /await finishOverlayClose\(\)/);
  assert.match(openBody, /activeOverlay = \{/);
  assert.match(closeBody, /classList\.add\('is-closing'\)/);
  assert.match(closeBody, /waitForVisualMotion/);
  assert.match(closeBody, /immediate \|\| prefersReducedMotion\(\)/);

  const usageSection = functionSource(
    js,
    'function accountUsageSection',
    'async function appendAccountUsage',
  );
  assert.match(usageSection, /skeletonRows\(6\)/);
  const fillUsage = functionSource(
    js,
    'async function fillAccountUsage',
    'function openUsageSheet',
  );
  assert.match(fillUsage, /section\.replaceChildren\(\)/);
});

test('privacy and account gates bypass any overlay motion', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );

  const gateView = functionSource(js, 'function gateView', 'function skeletonRows');
  assert.match(gateView, /void closeOverlay\(\{ immediate: true \}\);/);

  const closeOverlay = functionSource(
    js,
    'async function closeOverlay',
    'async function openSwitcher',
  );
  const immediateBranch = closeOverlay.indexOf('if (immediate || prefersReducedMotion())');
  const pendingBranch = closeOverlay.indexOf('if (lifecycle.closingPromise)');
  assert.ok(immediateBranch > 0, 'closeOverlay must support immediate removal');
  assert.ok(
    pendingBranch > immediateBranch,
    'an immediate safety close must preempt an exit already in progress',
  );
});

test('chat switching keeps the shell mounted and transitions only its content', async () => {
  const [js, css] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);

  assert.match(js, /const transcriptColumn = node\('div', \{ className: 'transcript-column' \}\)/);
  assert.match(js, /state\.shell = \{[\s\S]*?transcriptColumn,/);
  const openSession = functionSource(
    js,
    'async function openSession',
    'async function refreshMessages',
  );
  assert.match(openSession, /await transitionTranscriptOut\(controller\.signal\)/);

  const transcript = functionSource(
    js,
    'function renderTranscript',
    'function isMessageContinuation',
  );
  assert.match(transcript, /transitionTranscriptIn\(\)/);
  assert.match(
    js,
    /function transitionTranscriptIn\(\)[\s\S]*?classList\.add\('is-switching-in'\)/,
  );
  assert.match(transcript, /renderTranscriptPlaceholder/);
  assert.match(transcript, /!transcriptSessionChanged/);
  const chatContentOut = css.slice(
    css.indexOf('@keyframes chat-content-out'),
    css.indexOf('@keyframes chat-content-in'),
  );
  const chatContentIn = css.slice(
    css.indexOf('@keyframes chat-content-in'),
    css.indexOf('@keyframes sheet-in'),
  );
  assert.match(chatContentOut, /opacity:/);
  assert.match(chatContentIn, /opacity:/);
  assert.doesNotMatch(chatContentOut, /transform:/);
  assert.doesNotMatch(chatContentIn, /transform:/);
  assert.match(
    css,
    /\.data-row:active,\s*\n\.chat-chip:active \{\s*\n\s*transform: none;/,
    'large navigation targets must not shrink under the finger',
  );

  const strip = functionSource(js, 'function renderChatStrip', 'function renderTranscript');
  assert.match(strip, /const renderKey = JSON\.stringify/);
  assert.match(strip, /strip\.dataset\.renderKey === renderKey/);
  assert.match(strip, /strip\.dataset\.renderKey = renderKey/);

  const navigate = functionSource(js, 'function navigate', 'async function refreshWorkspaces');
  assert.match(navigate, /route\.view === 'transcript'[\s\S]*?return openSession\(/);
});

test('phone panels and transient controls move without animating layout', async () => {
  const [js, css] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);

  assert.match(css, /--motion-quick: 100ms;/);
  assert.match(css, /--motion-content: 140ms;/);
  assert.match(
    css,
    /@media \(max-width: 599px\) \{[\s\S]*?\.panel \{[\s\S]*?visibility: hidden;[\s\S]*?transform:/,
  );
  const phonePanels = css.slice(
    css.indexOf('@media (max-width: 599px)'),
    css.indexOf('@media (min-width: 600px)'),
  );
  const phonePanelRule = phonePanels.slice(
    phonePanels.indexOf('.panel {'),
    phonePanels.indexOf('.panel.is-active'),
  );
  assert.doesNotMatch(phonePanelRule, /opacity/);
  assert.match(css, /\.panel\.is-active \{[\s\S]*?visibility: visible;/);
  assert.match(css, /\.latest-button\.is-visible \{[\s\S]*?opacity: 1;[\s\S]*?transform:/);
  assert.match(js, /function setLatestButtonVisible\(/);
  assert.match(js, /setLatestButtonVisible\(latestButton, false\)/);
  const panelExposure = functionSource(
    js,
    'function syncPanelExposure',
    'function updateRoutePanels',
  );
  assert.match(panelExposure, /panel\.toggleAttribute\('inert', !active\)/);
  assert.match(panelExposure, /panel\.setAttribute\('aria-hidden', active \? 'false' : 'true'\)/);
  assert.match(js, /PHONE_LAYOUT\.addEventListener\('change', syncPanelExposure\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.status-dot\.working \{[\s\S]*?animation: none !important;/);

  const motionTransitions = [...css.matchAll(/transition:\s*([^;]+);/g)]
    .map((match) => match[1])
    .filter((value) => /motion-|\d+ms/.test(value));
  assert.ok(motionTransitions.length > 0);
  for (const transition of motionTransitions) {
    assert.doesNotMatch(transition, /\b(?:height|width|top|right|bottom|left|margin|padding)\b/);
  }
});
