import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import * as transcriptFocus from '../public/transcript-focus.js';

const source = (name) =>
  fs.readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');

function rule(css, selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `missing ${selector}`);
  const end = css.indexOf('}', start);
  return css.slice(start, end + 1);
}

class MountedContainer {
  constructor(children = []) {
    this.children = [];
    this.mutations = 0;
    for (const child of children) this.insertBefore(child, null);
    this.mutations = 0;
  }

  get lastElementChild() {
    return this.children.at(-1) || null;
  }

  insertBefore(child, before) {
    const mountedAt = this.children.indexOf(child);
    if (mountedAt >= 0) this.children.splice(mountedAt, 1);
    const target = before === null ? this.children.length : this.children.indexOf(before);
    assert.ok(target >= 0, 'the insertion anchor must be mounted');
    this.children.splice(target, 0, child);
    child.parentNode = this;
    this.mutations += 1;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    assert.ok(index >= 0, 'the removed child must be mounted');
    this.children.splice(index, 1);
    child.parentNode = null;
    child.detachCount = (child.detachCount || 0) + 1;
    this.mutations += 1;
  }
}

test('transcript reconciliation keeps unchanged mounted controls connected', () => {
  assert.equal(
    typeof transcriptFocus.reconcileMountedChildren,
    'function',
    'the transcript needs an in-place child reconciler',
  );
  const row = (id) => ({ id, parentNode: null, detachCount: 0 });
  const first = row('first');
  const retryControl = row('retry-control');
  const final = row('final');
  const container = new MountedContainer([first, retryControl, final]);

  transcriptFocus.reconcileMountedChildren(container, [first, retryControl, final]);
  assert.equal(container.mutations, 0);
  assert.equal(retryControl.parentNode, container);
  assert.equal(retryControl.detachCount, 0);

  const changedFirst = row('changed-first');
  transcriptFocus.reconcileMountedChildren(container, [changedFirst, retryControl, final]);
  assert.deepEqual(container.children, [changedFirst, retryControl, final]);
  assert.equal(retryControl.parentNode, container);
  assert.equal(retryControl.detachCount, 0);
  assert.equal(final.detachCount, 0);
});

test('mounted reconciliation restores a focused control after reordering it', () => {
  const first = { id: 'first', parentNode: null, isConnected: true };
  const focused = {
    id: 'focused',
    parentNode: null,
    isConnected: true,
    focusCalls: 0,
    focus(options) {
      assert.deepEqual(options, { preventScroll: true });
      this.focusCalls += 1;
      document.activeElement = this;
    },
  };
  const document = { activeElement: focused };
  const container = new MountedContainer([first, focused]);
  container.ownerDocument = document;
  container.contains = (element) => container.children.includes(element);
  const insertBefore = container.insertBefore.bind(container);
  container.insertBefore = (child, before) => {
    if (child === document.activeElement && container.children.includes(child)) {
      document.activeElement = { tagName: 'BODY' };
    }
    insertBefore(child, before);
  };

  transcriptFocus.reconcileMountedChildren(container, [focused, first]);

  assert.equal(focused.focusCalls, 1);
  assert.equal(document.activeElement, focused);
  assert.deepEqual(container.children, [focused, first]);
});

test('banner layout changes preserve the bottom or the reader and expose Latest', () => {
  assert.equal(typeof transcriptFocus.captureScrollAnchor, 'function');
  assert.equal(typeof transcriptFocus.restoreScrollAnchor, 'function');

  const pinned = {
    scrollHeight: 1_000,
    clientHeight: 500,
    scrollTop: 500,
  };
  const pinnedAnchor = transcriptFocus.captureScrollAnchor(pinned);
  pinned.clientHeight = 440;
  const pinnedResult = transcriptFocus.restoreScrollAnchor(pinned, pinnedAnchor);
  assert.equal(pinned.scrollTop, 560);
  assert.equal(pinnedResult.latestVisible, false);

  const reading = {
    scrollHeight: 1_000,
    clientHeight: 500,
    scrollTop: 260,
    viewportTop: 120,
    getBoundingClientRect() {
      return { top: this.viewportTop };
    },
  };
  const readingAnchor = transcriptFocus.captureScrollAnchor(reading);
  reading.clientHeight = 440;
  reading.viewportTop = 180;
  const readingResult = transcriptFocus.restoreScrollAnchor(reading, readingAnchor);
  assert.equal(
    reading.scrollTop,
    320,
    'an outside banner must not move the same transcript content on screen',
  );
  assert.equal(readingResult.latestVisible, true);
});

test('message render identity includes delivery labels and superseded guidance', () => {
  assert.equal(
    typeof transcriptFocus.transcriptMessageRenderIdentity,
    'function',
  );
  const base = {
    id: 'user-1',
    kind: 'user',
    text: 'hello',
    queued: true,
    createdAt: '2026-08-30T12:00:00.000Z',
    sentAt: null,
  };
  const queued = transcriptFocus.transcriptMessageRenderIdentity(base);
  const sent = transcriptFocus.transcriptMessageRenderIdentity({
    ...base,
    queued: false,
    sentAt: '2026-08-30T12:00:02.000Z',
  });
  assert.notEqual(queued, sent);

  const agentError = {
    id: 'error-1',
    kind: 'agent-error',
    rowId: 20,
    code: 'usage_limit',
  };
  assert.notEqual(
    transcriptFocus.transcriptMessageRenderIdentity(agentError, {
      newestRootEventRowId: 20,
    }),
    transcriptFocus.transcriptMessageRenderIdentity(agentError, {
      newestRootEventRowId: 21,
    }),
  );

  const failed = {
    id: 'failed-1',
    kind: 'optimistic',
    text: 'hello',
    delivery: 'failed',
    definitelyUnsent: true,
  };
  assert.notEqual(
    transcriptFocus.transcriptMessageRenderIdentity(failed),
    transcriptFocus.transcriptMessageRenderIdentity(failed, {
      deliveryAction: 'delete',
    }),
    'a claimed terminal action must repaint its busy state',
  );
});

test('only visible queued Mac rows request a bounded full reconciliation', () => {
  assert.equal(typeof transcriptFocus.visibleQueuedRowRefreshKey, 'function');
  assert.equal(typeof transcriptFocus.visibleQueuedRowIds, 'function');
  assert.equal(
    transcriptFocus.visibleQueuedRowRefreshKey([
      { id: 'agent', kind: 'assistant', queued: true },
      { id: 'sent', kind: 'user', queued: false },
    ]),
    null,
  );
  assert.equal(
    transcriptFocus.visibleQueuedRowRefreshKey([
      { id: 'invalid', rowId: -1, kind: 'user', queued: true },
    ]),
    null,
  );
  assert.match(
    transcriptFocus.visibleQueuedRowRefreshKey([
      { id: 'queued', rowId: 42, kind: 'user', queued: true },
    ]),
    /queued/,
  );
  assert.deepEqual(
    transcriptFocus.visibleQueuedRowIds([
      { id: 'queued', rowId: 42, kind: 'user', queued: true },
      { id: 'duplicate', rowId: 42, kind: 'user', queued: true },
      { id: 'invalid', rowId: -1, kind: 'user', queued: true },
    ]),
    [42],
  );
});

test('confirmed messages keep their send slot while later messages are pending', () => {
  const serverMessages = [
    {
      id: 'older-server-row',
      rowId: 10,
      createdAt: '2026-08-27T12:00:00.000Z',
    },
    {
      id: 'first-confirmed-row',
      rowId: 11,
      createdAt: '2026-08-27T12:00:03.000Z',
    },
  ];
  const pendingMessages = [
    {
      id: 'second-pending-message',
      kind: 'optimistic',
      createdAt: '2026-08-27T12:00:02.000Z',
    },
  ];

  assert.deepEqual(
    transcriptFocus
      .stableTranscriptMessages(serverMessages, pendingMessages)
      .map(({ id }) => id),
    [
      'older-server-row',
      'first-confirmed-row',
      'second-pending-message',
    ],
  );
});

test('a reconciled row is already seen when its optimistic bubble disappears', () => {
  const messages = [
    { id: 'confirmed-row', rowId: 42 },
    { id: 'other-row', rowId: 43 },
    { id: 'invalid-zero-row', rowId: 0 },
  ];
  const reconciled = [
    { id: 'optimistic:first', receiptRowId: 42 },
    { id: 'optimistic:baseline-only', receiptRowId: null },
  ];

  assert.deepEqual(
    transcriptFocus.reconciledTranscriptMessageIds(messages, reconciled),
    ['confirmed-row'],
  );
});

test('a Mac user row waits for the receipt before replacing its optimistic bubble', async () => {
  const incoming = [{ id: 'mac-row', kind: 'user', rowId: 42 }];
  const active = [{
    id: 'optimistic:first',
    sessionId: 'session-a',
    delivery: 'delivering',
  }];

  assert.equal(
    transcriptFocus.transcriptRefreshShouldWait(
      incoming,
      active,
      'session-a',
    ),
    true,
  );
  assert.equal(
    transcriptFocus.transcriptRefreshShouldWait(
      [{ id: 'assistant-row', kind: 'assistant', rowId: 42 }],
      active,
      'session-a',
    ),
    false,
  );
  assert.equal(
    transcriptFocus.transcriptRefreshShouldWait(
      incoming,
      [{ ...active[0], delivery: 'delivered' }],
      'session-a',
    ),
    false,
  );
  assert.equal(
    transcriptFocus.transcriptRefreshShouldWait(
      incoming,
      active,
      'session-b',
    ),
    false,
  );

  const js = await source('app.js');
  const refreshStart = js.indexOf('async function refreshMessages(');
  const refreshEnd = js.indexOf('function dedupeMessages', refreshStart);
  const refresh = js.slice(refreshStart, refreshEnd);
  assert.ok(
    refresh.indexOf('transcriptRefreshShouldWait(') <
      refresh.indexOf('state.messagesBySession.set('),
    'the duplicate row must wait before it can enter rendered state',
  );
  assert.ok(
    refresh.indexOf('state.messagesBySession.set(') <
      refresh.indexOf('const reconciled = reconcileOptimistic(sessionId)'),
    'the accepted Mac row must exist before receipt reconciliation',
  );
  assert.ok(
    refresh.indexOf('const reconciled = reconcileOptimistic(sessionId)') <
      refresh.indexOf('renderTranscript()'),
    'the optimistic bubble must reconcile before the accepted row renders',
  );
});

test('delivery labels cannot resize a short user bubble', async () => {
  const css = await source('app.css');
  const message = rule(css, '.message.user {');
  const content = rule(css, '.user-content {');

  assert.match(message, /display:\s*flex/);
  assert.match(message, /width:\s*85%/);
  assert.match(message, /flex-direction:\s*column/);
  assert.match(message, /align-items:\s*flex-end/);
  assert.match(content, /max-width:\s*100%/);
  assert.doesNotMatch(
    css,
    /\.message\.user:has\(\.message-meta\.terminal\)\s*\{[^}]*\bwidth:/,
  );
});

test('terminal action progress keeps the same button geometry', async () => {
  const [js, css] = await Promise.all([source('app.js'), source('app.css')]);
  const start = js.indexOf("} else if (message.delivery === 'failed')");
  const end = js.indexOf('const reason =', start);
  const failed = js.slice(start, end);

  assert.match(failed, /text: 'Retry'/);
  assert.match(failed, /text: 'Edit'/);
  assert.match(failed, /text: 'Check'/);
  assert.match(failed, /text: 'Delete'/);
  assert.match(failed, /'aria-busy': activeAction === 'delete'/);
  assert.match(
    css,
    /\.message-retry\[aria-busy='true'\] \{[\s\S]*?color:\s*transparent/,
  );
  assert.match(
    css,
    /\.message-retry\[aria-busy='true'\]::after \{[\s\S]*?position:\s*absolute/,
  );
});

test('the keyboard inset is subtracted from the shell exactly once', async () => {
  const css = await source('app.css');

  assert.match(
    rule(css, '#app {'),
    /height:\s*calc\(100% - var\(--keyboard-inset, 0px\)\)/,
  );
  assert.match(
    css,
    /\.app-shell,\s*\n\.gate\s*\{[\s\S]*?height:\s*100%/,
  );
  assert.doesNotMatch(
    rule(css, '#app,\n.app-shell,\n.gate {'),
    /height:/,
  );
});

test('new rows do not pull an unpinned reader down the transcript', async () => {
  const js = await source('app.js');
  const renderStart = js.indexOf('function renderTranscript()');
  const renderEnd = js.indexOf('function isMessageContinuation', renderStart);
  const render = js.slice(renderStart, renderEnd);
  const panelsStart = js.indexOf('function updateRoutePanels()');
  const panelsEnd = js.indexOf('function clearRenderedSessionView', panelsStart);
  const panels = js.slice(panelsStart, panelsEnd);

  assert.match(render, /const scrollTopBefore = transcriptScroll\.scrollTop/);
  assert.match(
    render,
    /if \(pinned\)[\s\S]*else \{[\s\S]*transcriptScroll\.scrollTop = Math\.max\(0, scrollTopBefore\)/,
  );
  assert.doesNotMatch(
    render,
    /transcriptScroll\.scrollHeight -\s*\n\s*transcriptScroll\.clientHeight -\s*\n\s*distanceBefore/,
  );
  assert.match(js, /let transcriptHiddenScrollTop = null/);
  assert.match(panels, /transcriptHiddenScrollTop = scroller\.scrollTop/);
  assert.match(
    panels,
    /scroller\.scrollTop = Math\.max\(0, transcriptHiddenScrollTop\)/,
  );
});

test('landscape content respects both phone safe areas', async () => {
  const css = await source('app.css');

  assert.match(
    rule(css, '.data-row {'),
    /max\(var\(--screen-gutter\), env\(safe-area-inset-right\)\)[\s\S]*max\(var\(--screen-gutter\), env\(safe-area-inset-left\)\)/,
  );
  assert.match(
    rule(css, '.transcript-scroll {'),
    /max\(var\(--screen-gutter\), env\(safe-area-inset-right\)\)[\s\S]*max\(var\(--screen-gutter\), env\(safe-area-inset-left\)\)/,
  );
  assert.match(
    rule(css, '.chat-strip {'),
    /max\(10px, env\(safe-area-inset-right\)\)[\s\S]*max\(10px, env\(safe-area-inset-left\)\)/,
  );
});

test('chat workspace context stays readable in every color scheme', async () => {
  const css = await source('app.css');
  const workspace = rule(css, '.chip-workspace {');

  assert.match(workspace, /font-size:\s*0\.75rem/);
  assert.match(workspace, /opacity:\s*0\.92/);
});

test('the transcript mutates rows in place and bounds queued row refreshes', async () => {
  const js = await source('app.js');
  const renderStart = js.indexOf('function renderTranscript()');
  const renderEnd = js.indexOf('function isMessageContinuation', renderStart);
  const render = js.slice(renderStart, renderEnd);

  assert.match(render, /reconcileMountedChildren\(messageList, desiredChildren\)/);
  assert.doesNotMatch(render, /messageList\.replaceChildren/);
  assert.match(render, /scheduleVisibleQueuedRowRefresh\(entries\)/);
  assert.match(js, /const QUEUED_ROW_REFRESH_MAX_ATTEMPTS = [1-9]/);
  assert.match(
    js,
    /refreshMessages\(sessionId, \{[\s\S]*full: true,[\s\S]*timeoutMs: LIVE_REFRESH_REQUEST_MS/,
  );
  assert.match(js, /queuedRowIds=\$\{encodeURIComponent/);
  assert.match(js, /Array\.isArray\(data\.refreshed\)/);
  assert.match(js, /Array\.isArray\(data\.missingQueuedRowIds\)/);
  assert.match(js, /missingQueuedRowIds\.has\(Number\(message\.rowId\)\)/);
  assert.match(js, /refreshedById\.get\(message\.id\) \|\| message/);

  const bannerStart = js.indexOf('const bannerAnchor = captureScrollAnchor');
  const bannerEnd = js.indexOf('// Measured against the content still on screen');
  const banner = js.slice(bannerStart, bannerEnd);
  assert.ok(bannerStart >= 0 && bannerEnd > bannerStart);
  assert.match(banner, /renderBanner\(transcriptBanner\)/);
  assert.match(banner, /restoreScrollAnchor\(transcriptScroll, bannerAnchor\)/);
  assert.match(banner, /setLatestButtonVisible/);
});
