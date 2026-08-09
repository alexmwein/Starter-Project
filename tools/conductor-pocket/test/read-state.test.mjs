import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  READ_DWELL_MS,
  advanceReadProgress,
  effectiveSessionUnreadCount,
  effectiveWorkspaceUnreadCount,
  emptyReadProgress,
  normalizeReadReceipts,
  normalizeUnreadHeads,
  readableResponseRange,
  readReceiptSnapshot,
} from '../public/read-state.js';

const sessionId = 'session-123456789';
const workspaceId = 'workspace-123456789';
const responseId = 'response-123456789';

function heads(items = [{
  sessionId,
  workspaceId,
  unreadCount: 1,
  responseId,
}]) {
  return normalizeUnreadHeads(
    items.map((item) => ({
      ...item,
      status: item.status === undefined ? 'idle' : item.status,
    })),
  );
}

function receipts(items = [{
  sessionId,
  responseId,
  readAt: 1_000,
}]) {
  return normalizeReadReceipts(
    items.map((item) => ({
      ...item,
      unreadCount: item.unreadCount === undefined ? 1 : item.unreadCount,
    })),
  );
}

test('a matching persisted response clears only Pocket effective unread state', () => {
  assert.equal(
    effectiveSessionUnreadCount({
      sessionId,
      nativeUnreadCount: 1,
      unreadHeads: heads(),
      readReceipts: receipts(),
      headsLoaded: true,
    }),
    0,
  );
  assert.equal(
    effectiveSessionUnreadCount({
      sessionId,
      nativeUnreadCount: 0,
      unreadHeads: heads(),
      readReceipts: new Map(),
      headsLoaded: true,
    }),
    1,
  );
});

test('a new stable response identity restores unread even when the native count stays one', () => {
  assert.equal(
    effectiveSessionUnreadCount({
      sessionId,
      nativeUnreadCount: 1,
      unreadHeads: heads([{ sessionId, workspaceId, unreadCount: 1, responseId: 'new-response-123456' }]),
      readReceipts: receipts(),
      headsLoaded: true,
    }),
    1,
  );
});

test('large exact unread counts never collide in a receipt key', () => {
  assert.equal(
    effectiveSessionUnreadCount({
      sessionId,
      nativeUnreadCount: 1_000,
      unreadHeads: heads([{
        sessionId,
        workspaceId,
        unreadCount: 1_000,
        responseId,
      }]),
      readReceipts: receipts([{
        sessionId,
        responseId,
        unreadCount: 999,
        readAt: 1_000,
      }]),
      headsLoaded: true,
    }),
    1_000,
  );
});

test('a fresh unread head wins stale session counts and mismatched receipts fail unread', () => {
  assert.equal(
    effectiveSessionUnreadCount({
      sessionId,
      nativeUnreadCount: 0,
      unreadHeads: heads(),
      readReceipts: new Map(),
      headsLoaded: true,
    }),
    1,
  );
  assert.equal(
    effectiveSessionUnreadCount({
      sessionId,
      nativeUnreadCount: 2,
      unreadHeads: heads(),
      readReceipts: new Map(),
      headsLoaded: true,
    }),
    2,
  );
  assert.equal(
    effectiveSessionUnreadCount({
      sessionId,
      nativeUnreadCount: 1,
      unreadHeads: heads(),
      readReceipts: receipts([{
        sessionId,
        responseId,
        unreadCount: 2,
        readAt: 1_000,
      }]),
      headsLoaded: true,
    }),
    1,
  );
});

test('missing, malformed, and ambiguous head metadata fails unread', () => {
  for (const unreadHeads of [
    new Map(),
    heads([{ sessionId, workspaceId, unreadCount: 1, responseId: null }]),
    heads([{ sessionId, workspaceId, unreadCount: 1, responseId, status: null }]),
    heads([
      { sessionId, workspaceId, unreadCount: 1, responseId },
      { sessionId, workspaceId, unreadCount: 1, responseId: 'different-response-123' },
    ]),
  ]) {
    assert.equal(
      effectiveSessionUnreadCount({
        sessionId,
        nativeUnreadCount: 1,
        unreadHeads,
        readReceipts: receipts(),
        headsLoaded: true,
      }),
      1,
    );
  }
});

test('workspace counts subtract only a complete and matching breakdown', () => {
  const secondSessionId = 'session-987654321';
  const unreadHeads = heads([
    { sessionId, workspaceId, unreadCount: 1, responseId },
    {
      sessionId: secondSessionId,
      workspaceId,
      unreadCount: 1,
      responseId: 'response-987654321',
    },
  ]);
  assert.equal(
    effectiveWorkspaceUnreadCount({
      workspaceId,
      nativeUnreadCount: 2,
      unreadHeads,
      readReceipts: receipts(),
      headsLoaded: true,
    }),
    1,
  );
  assert.equal(
    effectiveWorkspaceUnreadCount({
      workspaceId,
      nativeUnreadCount: 3,
      unreadHeads,
      readReceipts: receipts(),
      headsLoaded: true,
    }),
    3,
  );
  assert.equal(
    effectiveWorkspaceUnreadCount({
      workspaceId,
      nativeUnreadCount: 0,
      unreadHeads,
      readReceipts: new Map(),
      headsLoaded: true,
    }),
    2,
  );
});

test('receipt snapshots are bounded, sanitized, and merge distinct response versions', () => {
  const normalized = normalizeReadReceipts([
    { sessionId, responseId, unreadCount: 1, readAt: 50 },
    { sessionId, responseId, unreadCount: 1, readAt: 100 },
    { sessionId, responseId: 'older-response-123', unreadCount: 1, readAt: 75 },
    { sessionId: 'bad', responseId: '', unreadCount: 1, readAt: 200 },
  ]);
  assert.deepEqual(readReceiptSnapshot(normalized), [
    { sessionId, responseId, unreadCount: 1, readAt: 100 },
    {
      sessionId,
      responseId: 'older-response-123',
      unreadCount: 1,
      readAt: 75,
    },
  ]);
});

test('the readable target includes every primary text block from the exact response', () => {
  assert.deepEqual(
    readableResponseRange([
      { id: 'old', kind: 'assistant', importance: 'primary', responseId: 'old-response-123456' },
      { id: 'first', kind: 'assistant', importance: 'primary', responseId },
      { id: 'second', kind: 'assistant', importance: 'primary', responseId },
      { id: 'progress', kind: 'activity', responseId },
    ], responseId),
    {
      responseId,
      firstMessageId: 'first',
      lastMessageId: 'second',
    },
  );
  assert.equal(readableResponseRange([], responseId), null);
  assert.equal(
    readableResponseRange([
      { id: 'first', kind: 'assistant', importance: 'primary', responseId },
      {
        id: 'newest',
        kind: 'assistant',
        importance: 'primary',
        responseId: 'newer-response-123456',
      },
    ], responseId),
    null,
  );
});

test('a short fully visible response acknowledges only after a continuous dwell', () => {
  const sample = {
    eligible: true,
    key: 'candidate-short-123',
    gestureSequence: 0,
    long: false,
    fullyVisible: true,
    topVisible: true,
    bottomVisible: true,
  };
  const started = advanceReadProgress(emptyReadProgress(), sample, 100);
  assert.equal(started.acknowledge, false);
  assert.equal(
    advanceReadProgress(started.progress, sample, 100 + READ_DWELL_MS - 1)
      .acknowledge,
    false,
  );
  assert.equal(
    advanceReadProgress(started.progress, sample, 100 + READ_DWELL_MS)
      .acknowledge,
    true,
  );
});

test('leaving the fully visible position resets the short-response dwell', () => {
  const visible = {
    eligible: true,
    key: 'candidate-short-123',
    gestureSequence: 0,
    long: false,
    fullyVisible: true,
  };
  const started = advanceReadProgress(emptyReadProgress(), visible, 100);
  const left = advanceReadProgress(
    started.progress,
    { ...visible, fullyVisible: false },
    400,
  );
  assert.equal(left.progress.bottomSince, null);
  assert.equal(
    advanceReadProgress(left.progress, visible, 100 + READ_DWELL_MS)
      .acknowledge,
    false,
  );
});

test('a long response requires a user gesture, then its top, then its bottom', () => {
  const base = {
    eligible: true,
    key: 'candidate-long-123',
    gestureSequence: 4,
    long: true,
    fullyVisible: false,
    topVisible: true,
    bottomVisible: false,
  };
  const opened = advanceReadProgress(emptyReadProgress(), base, 0);
  assert.equal(opened.progress.topSeen, false);
  const touchedAtTop = advanceReadProgress(
    opened.progress,
    { ...base, gestureSequence: 5 },
    10,
  );
  assert.equal(touchedAtTop.progress.topSeen, true);
  const reachedBottom = advanceReadProgress(
    touchedAtTop.progress,
    {
      ...base,
      gestureSequence: 5,
      topVisible: false,
      bottomVisible: true,
    },
    200,
  );
  assert.equal(reachedBottom.acknowledge, false);
  assert.equal(
    advanceReadProgress(
      reachedBottom.progress,
      {
        ...base,
        gestureSequence: 5,
        topVisible: false,
        bottomVisible: true,
      },
      200 + READ_DWELL_MS,
    ).acknowledge,
    true,
  );
});

test('backgrounding, route changes, and new response keys cancel pending dwell', () => {
  const sample = {
    eligible: true,
    key: 'candidate-short-123',
    gestureSequence: 0,
    long: false,
    fullyVisible: true,
  };
  const started = advanceReadProgress(emptyReadProgress(), sample, 100);
  assert.deepEqual(
    advanceReadProgress(started.progress, { ...sample, eligible: false }, 200)
      .progress,
    emptyReadProgress(),
  );
  const replaced = advanceReadProgress(
    started.progress,
    { ...sample, key: 'candidate-new-response-123' },
    100 + READ_DWELL_MS,
  );
  assert.equal(replaced.acknowledge, false);
  assert.equal(replaced.progress.bottomSince, 100 + READ_DWELL_MS);
});

test('the app arms receipts only from a foreground live baseline and persists before clearing', async () => {
  const source = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /document\.hidden[\s\S]*document\.hasFocus\(\)[\s\S]*state\.route\.view !== 'transcript'[\s\S]*privacy-shield[\s\S]*overlayRoot\.childElementCount > 0/,
  );
  assert.match(source, /state\.connection !== 'live'/);
  assert.match(
    source,
    /messageBaselinesBySession\.has\(sessionId\)[\s\S]*messageLiveEpochBySession\.get\(sessionId\) !== state\.visibilityEpoch/,
  );
  const persist = source.indexOf(
    'const snapshot = await mergeReadReceiptRequired({',
  );
  const clearInMemory = source.indexOf(
    'state.readReceipts = normalizeReadReceipts(snapshot);',
    persist,
  );
  assert.ok(persist >= 0);
  assert.ok(clearInMemory > persist);
  assert.match(
    source,
    /mergeReadReceiptRequired[\s\S]*transaction\('snapshots', 'readwrite'\)[\s\S]*store\.get\(READ_RECEIPTS_KEY\)[\s\S]*store\.put\(snapshot, READ_RECEIPTS_KEY\)/,
  );
  assert.match(
    source,
    /eventSource\.addEventListener\('change'[\s\S]*invalidateUnreadHeadEvidence\(\)[\s\S]*transcriptRefresh\.schedule\(\)/,
  );
  assert.match(
    source,
    /eventSource\.addEventListener\('ready'[\s\S]*invalidateUnreadHeadEvidence\(\)[\s\S]*transcriptRefresh\.schedule\(\)[\s\S]*metadataRefresh\.schedule\(\)[\s\S]*transcriptRefresh\.flush\(\)[\s\S]*metadataRefresh\.flush\(\)/,
  );
  assert.match(
    source,
    /eventSource\.onerror[\s\S]*invalidateUnreadHeadEvidence\(\)/,
  );
  assert.match(
    source,
    /state\.heartbeatTimer = setInterval[\s\S]*state\.unreadHeadsLoaded[\s\S]*invalidateUnreadHeadEvidence\(\)/,
  );
  assert.match(
    source,
    /startEvents\(\);[\s\S]*transcriptRefresh\.schedule\(\);[\s\S]*metadataRefresh\.schedule\(\);/,
  );
  assert.doesNotMatch(source, /\/api\/sessions\/[^'`]*\/read/);
});
