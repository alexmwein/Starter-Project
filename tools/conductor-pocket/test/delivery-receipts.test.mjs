import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  createDeliveryActionCoordinator,
  deliveryNeedsAutomaticRecovery,
  deliveryRecoveryDecision,
  deliveryStatusIsTerminal,
  readDeliveryStatusResponse,
  receiptReachedTranscript,
  reconcileDeliveryReceipts,
  terminalDeliveryActionDisposition,
} from '../public/delivery-receipts.js';

test('the client receipt parser preserves body aborts and rejects malformed success', async () => {
  const abort = new Error('timed out');
  abort.name = 'AbortError';
  await assert.rejects(
    readDeliveryStatusResponse({
      ok: true,
      status: 200,
      async json() {
        throw abort;
      },
    }),
    (error) => error === abort,
  );
  await assert.rejects(
    readDeliveryStatusResponse({
      ok: true,
      status: 200,
      async json() {
        return {};
      },
    }),
    { code: 'delivery_status_invalid_response' },
  );
  assert.deepEqual(
    await readDeliveryStatusResponse({
      ok: true,
      status: 200,
      async json() {
        return { delivery: { state: 'delivered', rowId: 42 } };
      },
    }),
    { state: 'delivered', rowId: 42 },
  );
});

test('delivered and authoritative final delivery statuses are terminal', () => {
  assert.equal(deliveryStatusIsTerminal({ state: 'delivered' }), true);
  assert.equal(
    deliveryStatusIsTerminal({
      state: 'failed',
      code: 'workspace_not_visible',
      retrySafe: true,
    }),
    true,
  );
  assert.equal(
    deliveryStatusIsTerminal({
      state: 'failed',
      code: 'automation_timeout',
      retrySafe: false,
      final: true,
    }),
    true,
  );
  assert.equal(
    deliveryStatusIsTerminal({
      state: 'failed',
      code: 'send_not_confirmed',
      retrySafe: false,
    }),
    false,
  );
  assert.equal(deliveryStatusIsTerminal({ state: 'unknown' }), false);
  assert.equal(deliveryStatusIsTerminal({ state: 'pending' }), false);
});

test('terminal delivery actions continue only for authoritative failures', () => {
  assert.equal(
    terminalDeliveryActionDisposition({ state: 'delivered' }),
    'resolved',
  );
  assert.equal(
    terminalDeliveryActionDisposition({
      state: 'failed',
      retrySafe: true,
    }),
    'actionable',
  );
  assert.equal(
    terminalDeliveryActionDisposition({
      state: 'failed',
      retrySafe: false,
      final: true,
    }),
    'actionable',
  );
  assert.equal(
    terminalDeliveryActionDisposition({
      state: 'failed',
      retrySafe: false,
    }),
    'unverified',
  );
  assert.equal(
    terminalDeliveryActionDisposition({
      state: 'pending',
      phase: 'automating',
    }),
    'pending',
  );
  assert.equal(
    terminalDeliveryActionDisposition({ state: 'unknown' }),
    'unverified',
  );
});

test('rapid terminal action taps run one operation and expose its busy label', async () => {
  const changes = [];
  const coordinator = createDeliveryActionCoordinator({
    onChange(key, action) {
      changes.push([key, action]);
    },
  });
  let release;
  let calls = 0;
  const first = coordinator.run('optimistic-1', 'retry', async () => {
    calls += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const second = await coordinator.run(
    'optimistic-1',
    'edit',
    async () => {
      calls += 1;
      return 'duplicate';
    },
  );

  assert.equal(calls, 1);
  assert.equal(coordinator.current('optimistic-1'), 'retry');
  assert.deepEqual(second, { started: false, value: null });

  release('claimed');
  assert.deepEqual(await first, { started: true, value: 'claimed' });
  assert.equal(coordinator.current('optimistic-1'), null);
  assert.deepEqual(changes, [
    ['optimistic-1', 'retry'],
    ['optimistic-1', null],
  ]);
});

test('inconclusive delivery statuses remain recoverable through slow receipt checks', () => {
  let inconclusiveChecks = 0;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const decision = deliveryRecoveryDecision(
      { state: 'unknown' },
      inconclusiveChecks,
    );
    inconclusiveChecks = decision.inconclusiveChecks;
    assert.equal(decision.action, 'retry');
    assert.equal(inconclusiveChecks, attempt);
  }

  assert.deepEqual(
    deliveryRecoveryDecision({ state: 'delivered' }, inconclusiveChecks),
    { action: 'settle', inconclusiveChecks: 0 },
  );

  assert.deepEqual(
    deliveryRecoveryDecision(
      { state: 'failed', retrySafe: false, final: true },
      2,
    ),
    { action: 'settle', inconclusiveChecks: 0 },
  );
  assert.deepEqual(
    deliveryRecoveryDecision({ state: 'pending', phase: 'confirming' }, 2),
    { action: 'poll', inconclusiveChecks: 0 },
  );
});

test('automatic recovery re-arms legacy exhausted ambiguous notices', () => {
  assert.equal(
    deliveryNeedsAutomaticRecovery({ delivery: 'delivering' }),
    true,
  );
  assert.equal(
    deliveryNeedsAutomaticRecovery({ delivery: 'confirming' }),
    true,
  );
  assert.equal(
    deliveryNeedsAutomaticRecovery({
      delivery: 'failed',
      definitelyUnsent: false,
    }),
    true,
  );
  assert.equal(
    deliveryNeedsAutomaticRecovery({
      delivery: 'failed',
      definitelyUnsent: false,
      deliveryRecoveryExhausted: true,
      errorCode: 'delivery_unknown',
    }),
    true,
  );
  assert.equal(
    deliveryNeedsAutomaticRecovery({
      delivery: 'failed',
      definitelyUnsent: true,
    }),
    false,
  );
  assert.equal(
    deliveryNeedsAutomaticRecovery({
      delivery: 'failed',
      definitelyUnsent: false,
      deliveryRecoveryExhausted: true,
      errorCode: 'automation_timeout',
    }),
    false,
  );
  assert.equal(
    deliveryNeedsAutomaticRecovery({
      delivery: 'failed',
      definitelyUnsent: false,
      deliveryRecoveryExhausted: true,
      errorCode: 'relay_restarted_during_send',
    }),
    false,
  );
  assert.equal(
    deliveryNeedsAutomaticRecovery({
      delivery: 'failed',
      definitelyUnsent: false,
      deliveryRecoveryExhausted: true,
      errorCode: 'device_locked',
    }),
    false,
  );
});

function optimistic(overrides = {}) {
  return {
    id: 'optimistic-1',
    kind: 'optimistic',
    sessionId: 'session-1',
    delivery: 'delivered',
    receiptBaselineCursor: 10,
    receiptRowId: null,
    ...overrides,
  };
}

test('a delivery receipt reconciles only after its transcript boundary arrives', () => {
  const message = optimistic();
  assert.equal(receiptReachedTranscript(message, 10), false);
  assert.equal(receiptReachedTranscript(message, 11), true);
  assert.equal(
    receiptReachedTranscript(
      optimistic({ receiptRowId: 12 }),
      11,
    ),
    false,
  );
  assert.equal(
    receiptReachedTranscript(
      optimistic({ receiptRowId: 12 }),
      12,
    ),
    true,
  );
});

test('reconciliation is receipt-based and never compares message text', () => {
  const delivered = optimistic({ id: 'delivered', text: 'same text' });
  const failed = optimistic({
    id: 'failed',
    text: 'same text',
    delivery: 'failed',
  });
  const otherSession = optimistic({
    id: 'other-session',
    sessionId: 'session-2',
  });

  const result = reconcileDeliveryReceipts(
    [delivered, failed, otherSession],
    'session-1',
    11,
  );

  assert.deepEqual(result.reconciled, [delivered]);
  assert.deepEqual(result.remaining, [failed, otherSession]);
});

test('invalid or absent receipt cursors fail closed', () => {
  for (const receipt of [
    optimistic({
      receiptBaselineCursor: null,
      receiptRowId: null,
    }),
    optimistic({ receiptBaselineCursor: -1 }),
    optimistic({ receiptBaselineCursor: 1.5 }),
    optimistic({ receiptBaselineCursor: Number.MAX_SAFE_INTEGER + 1 }),
  ]) {
    assert.equal(receiptReachedTranscript(receipt, 50), false);
  }
});

test('failed and definitely-unsent messages survive receipt reconciliation', () => {
  const unknown = optimistic({
    id: 'unknown',
    delivery: 'failed',
    retrySafe: false,
    errorCode: 'send_not_confirmed',
  });
  const definitelyUnsent = optimistic({
    id: 'not-sent',
    delivery: 'failed',
    retrySafe: true,
    definitelyUnsent: true,
    errorCode: 'workspace_list_unavailable',
  });
  const delivered = optimistic({ id: 'delivered' });

  const result = reconcileDeliveryReceipts(
    [unknown, definitelyUnsent, delivered],
    'session-1',
    11,
  );

  assert.deepEqual(result.reconciled, [delivered]);
  assert.deepEqual(result.remaining, [unknown, definitelyUnsent]);
});

test('recovering typed text never requires proof, resending always does', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );

  // An absent ledger entry looks like proof a message was never sent and is
  // not: the ledger evicts on CAPACITY as well as age, so a delivered receipt
  // can be dropped early and no age check can see that. Acting on it resends a
  // message that already went out. An earlier version of this file did exactly
  // that, so the invariant is pinned rather than left to memory.
  const settleStart = js.indexOf('async function settleTerminalDeliveryStatus');
  assert.ok(settleStart > 0, 'settleTerminalDeliveryStatus must exist');
  const settleBody = js.slice(settleStart, js.indexOf('\n}\n', settleStart));
  assert.doesNotMatch(
    settleBody,
    /delivery\.state === 'absent'[\s\S]*definitelyUnsent = true/,
    'an absent ledger entry must never be treated as proof a message was unsent',
  );

  // Editing returns the text to the composer and sends nothing, so it is safe
  // whatever happened to the original. Requiring proof left an ambiguous
  // failure with no way to recover what was typed.
  const editStart = js.indexOf('async function editFailedMessage(message)');
  assert.ok(editStart > 0, 'editFailedMessage must exist');
  const editBody = js.slice(editStart, js.indexOf('\n}\n', editStart));
  assert.doesNotMatch(
    editBody,
    /message\.definitelyUnsent !== true/,
    'recovering typed text must not require proof the send failed',
  );
  assert.doesNotMatch(
    editBody,
    /verifyTerminalDeliveryAction\(message\)/,
    'recovering typed text must not depend on a reachable status endpoint',
  );
  assert.match(
    editBody,
    /claimTerminalDeliveryActionRequired\(message, 'edit'\)/,
    'the atomic local claim remains the cross-window edit gate',
  );

  // The claim gate must treat edit like delete, not like retry.
  assert.match(
    js,
    /\(action === 'delete' \|\|\s*\n?\s*action === 'edit' \|\|/,
  );

  // Retry keeps its proof requirement, because it is the one that resends.
  const canRetryStart = js.indexOf('function deliveryCanRetry(message) {');
  const canRetryBody = js.slice(canRetryStart, js.indexOf('\n}\n', canRetryStart));
  assert.match(canRetryBody, /message\.retrySafe === true/);
  assert.match(canRetryBody, /message\.definitelyUnsent === true/);
})

test('failed terminal verification reaches one visible action path', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const verifyStart = js.indexOf(
    'async function verifyTerminalDeliveryAction(message)',
  );
  const verifyEnd = js.indexOf(
    'function applyAuthoritativePendingDelivery',
    verifyStart,
  );
  const verify = js.slice(verifyStart, verifyEnd);
  assert.match(verify, /terminalDeliveryActionDisposition\(delivery\)/);
  const actionableStart = verify.indexOf("if (disposition === 'actionable')");
  const actionableEnd = verify.indexOf(
    "if (disposition === 'pending')",
    actionableStart,
  );
  const actionable = verify.slice(actionableStart, actionableEnd);
  assert.match(
    actionable,
    /settleTerminalDeliveryStatus\(message, delivery\)[\s\S]*return message/,
  );
  assert.doesNotMatch(actionable, /return null/);
  assert.match(
    verify,
    /disposition === 'resolved'[\s\S]*settleTerminalDeliveryStatus\(message, delivery\)[\s\S]*return null/,
  );

  const retryStart = js.indexOf('async function retryMessage(message)');
  const retryEnd = js.indexOf('async function claimConflictAction', retryStart);
  const retry = js.slice(retryStart, retryEnd);
  assert.match(retry, /deliveryActionCoordinator\.run\(/);
  assert.match(retry, /claimTerminalDeliveryActionRequired\(message, 'retry'\)/);
  assert.match(retry, /void deliverOptimistic\(message/);

  const checkStart = js.indexOf('async function checkDeliveryNow(message)');
  const checkEnd = js.indexOf('function checkDelivery(message', checkStart);
  const check = js.slice(checkStart, checkEnd);
  assert.match(check, /requestDeliveryStatus\(message\)/);
  assert.match(check, /terminalDeliveryActionDisposition\(delivery\)/);
  assert.doesNotMatch(
    check,
    /checkDelivery\(message/,
    'manual Check must not enqueue another two minute recovery pass',
  );
  assert.match(js, /activeAction === 'retry' \? 'Checking…' : 'Retry'/);
  assert.match(js, /click: \(\) => void checkDeliveryNow\(message\)/);
});

test('manual delivery actions cancel stale automatic recovery work', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const recoveryStart = js.indexOf('function checkDelivery(message');
  const recoveryEnd = js.indexOf('async function recoverPendingDeliveries');
  const recovery = js.slice(recoveryStart, recoveryEnd);
  assert.match(recovery, /function cancelDeliveryRecovery\(message\)/);
  assert.match(recovery, /cancelled: false/);
  assert.match(recovery, /deliveryRecoveryEntryIsCurrent\(entry\)/);
  assert.match(
    recovery,
    /deliveryNeedsAutomaticRecovery\(message\)[\s\S]*message\.delivery = 'confirming'/,
    'a queued recovery must recheck eligibility before changing visible state',
  );
  assert.match(
    recovery,
    /requestDeliveryStatus\(message\)[\s\S]*deliveryRecoveryEntryIsCurrent\(entry\)/,
    'an active recovery must stop after a manual action cancels it',
  );

  for (const functionName of [
    'discardFailedMessage',
    'editFailedMessage',
    'checkDeliveryNow',
    'retryMessage',
    'claimConflictAction',
  ]) {
    const start = js.indexOf(`function ${functionName}`);
    assert.ok(start > 0, `${functionName} must exist`);
    const body = js.slice(start, js.indexOf('\n}\n', start));
    assert.match(
      body,
      /cancelDeliveryRecovery\(message\)/,
      `${functionName} must cancel background recovery first`,
    );
  }
});
