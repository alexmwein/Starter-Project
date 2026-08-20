import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  deliveryNeedsAutomaticRecovery,
  deliveryRecoveryDecision,
  deliveryStatusIsTerminal,
  readDeliveryStatusResponse,
  receiptReachedTranscript,
  reconcileDeliveryReceipts,
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

test('a send that never reached the Mac can be retried and edited', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );

  // A send made while the Mac was unreachable (asleep, relay restarting, phone
  // off network) never reaches the ledger, so every recovery check came back
  // inconclusive and the delivery settled with retrySafe=false and
  // definitelyUnsent=false. That renders "Delivery unknown" with only a Check
  // button: no Retry, no Edit, and the typed text is stranded with no way to
  // recover it. Absence in the ledger is the most provably unsent case there
  // is, because the request never arrived.
  assert.match(js, /delivery\.state === 'absent'/);
  assert.match(js, /never_reached_mac/);
  const settleStart = js.indexOf('async function settleTerminalDeliveryStatus');
  const settleBody = js.slice(settleStart, js.indexOf('\n}\n', settleStart));
  const absentBranch = settleBody.slice(settleBody.indexOf("delivery.state === 'absent'"));
  assert.match(absentBranch, /message\.retrySafe = true;/);
  assert.match(absentBranch, /message\.definitelyUnsent = true;/);

  // Absence only proves anything while the entry could not already have been
  // pruned, or a message that really did send could be duplicated.
  assert.match(js, /function messageOlderThanLedger\(message, delivery\)/);
  const guardStart = js.indexOf('function messageOlderThanLedger(message, delivery)');
  const guardBody = js.slice(guardStart, js.indexOf('\n}\n', guardStart));
  // Everything unverifiable must count as older, so absence is never trusted
  // on a guess.
  assert.match(guardBody, /if \(!Number\.isFinite\(ttlMs\) \|\| ttlMs <= 0\) return true;/);
  assert.match(guardBody, /if \(!Number\.isFinite\(createdAt\)\) return true;/);
  assert.match(guardBody, /if \(age < 0\) return true;/);
  assert.match(guardBody, /ttlMs \/ 2/);

  // Retry and Edit are gated on definitelyUnsent, which is what was false.
  assert.match(js, /const definitelyUnsent = message\.definitelyUnsent === true;/);
})
