import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryNeedsAutomaticRecovery,
  deliveryRecoveryDecision,
  deliveryStatusIsTerminal,
  MAX_INCONCLUSIVE_DELIVERY_CHECKS,
  receiptReachedTranscript,
  reconcileDeliveryReceipts,
} from '../public/delivery-receipts.js';

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

test('inconclusive delivery statuses retry briefly and then exhaust', () => {
  let inconclusiveChecks = 0;
  for (
    let attempt = 1;
    attempt <= MAX_INCONCLUSIVE_DELIVERY_CHECKS;
    attempt += 1
  ) {
    const decision = deliveryRecoveryDecision(
      { state: 'unknown' },
      inconclusiveChecks,
    );
    inconclusiveChecks = decision.inconclusiveChecks;
    assert.equal(
      decision.action,
      attempt === MAX_INCONCLUSIVE_DELIVERY_CHECKS ? 'exhaust' : 'retry',
    );
  }

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

test('automatic recovery skips exhausted and definitely-unsent notices', () => {
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
    }),
    false,
  );
  assert.equal(
    deliveryNeedsAutomaticRecovery({
      delivery: 'failed',
      definitelyUnsent: true,
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
