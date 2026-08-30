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
