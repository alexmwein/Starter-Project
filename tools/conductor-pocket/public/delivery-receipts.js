function validCursor(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

const RECOVERY_TERMINAL_AUTH_CODES = new Set([
  'authentication_required',
  'device_locked',
  'device_revoked',
  'device_session_expired',
]);
const LEGACY_INCONCLUSIVE_RECOVERY_CODES = new Set([
  'delivery_confirmation_timeout',
  'delivery_status_invalid_response',
  'delivery_unknown',
]);

export function deliveryStatusIsTerminal(delivery) {
  return (
    delivery?.state === 'delivered' ||
    (delivery?.state === 'failed' &&
      (delivery.retrySafe === true || delivery.final === true))
  );
}

export async function readDeliveryStatusResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const invalidResponse = new Error('delivery_status_invalid_response');
    invalidResponse.code = 'delivery_status_invalid_response';
    throw invalidResponse;
  }
  if (!response.ok) {
    const error = new Error(
      payload?.error?.code || `http_${response.status}`,
    );
    error.code = payload?.error?.code || `http_${response.status}`;
    error.status = response.status;
    throw error;
  }
  if (!payload?.delivery || typeof payload.delivery !== 'object') {
    const invalidResponse = new Error('delivery_status_invalid_response');
    invalidResponse.code = 'delivery_status_invalid_response';
    throw invalidResponse;
  }
  return payload.delivery;
}

export function deliveryRecoveryDecision(
  delivery,
  inconclusiveChecks = 0,
) {
  if (deliveryStatusIsTerminal(delivery)) {
    return { action: 'settle', inconclusiveChecks: 0 };
  }
  if (delivery?.state === 'pending') {
    return { action: 'poll', inconclusiveChecks: 0 };
  }
  const currentInconclusiveChecks =
    Number.isSafeInteger(inconclusiveChecks) && inconclusiveChecks >= 0
      ? inconclusiveChecks
      : 0;
  const nextInconclusiveChecks = currentInconclusiveChecks + 1;
  return {
    // An absent, delayed, or timed-out receipt is never proof that delivery
    // failed. The caller owns the polling window and may re-arm recovery when
    // the app becomes visible or the network reconnects.
    action: 'retry',
    inconclusiveChecks: nextInconclusiveChecks,
  };
}

export function deliveryNeedsAutomaticRecovery(message) {
  return (
    message?.definitelyUnsent !== true &&
    !RECOVERY_TERMINAL_AUTH_CODES.has(message?.errorCode) &&
    (message?.deliveryRecoveryExhausted !== true ||
      LEGACY_INCONCLUSIVE_RECOVERY_CODES.has(message?.errorCode)) &&
    (message?.delivery === 'delivering' ||
      message?.delivery === 'confirming' ||
      (message?.delivery === 'failed' &&
        message.definitelyUnsent !== true))
  );
}

export function receiptReachedTranscript(message, transcriptCursor) {
  if (message.delivery !== 'delivered' || !validCursor(transcriptCursor)) {
    return false;
  }
  if (validCursor(message.receiptRowId)) {
    return transcriptCursor >= message.receiptRowId;
  }
  if (validCursor(message.receiptBaselineCursor)) {
    return transcriptCursor > message.receiptBaselineCursor;
  }
  return false;
}

export function reconcileDeliveryReceipts(
  optimisticMessages,
  sessionId,
  transcriptCursor,
) {
  const reconciled = [];
  const remaining = optimisticMessages.filter((message) => {
    if (
      message.sessionId !== sessionId ||
      !receiptReachedTranscript(message, transcriptCursor)
    ) {
      return true;
    }
    reconciled.push(message);
    return false;
  });
  return { remaining, reconciled };
}
