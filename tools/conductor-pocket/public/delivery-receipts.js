function validCursor(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export const MAX_INCONCLUSIVE_DELIVERY_CHECKS = 3;

export function deliveryStatusIsTerminal(delivery) {
  return (
    delivery?.state === 'delivered' ||
    (delivery?.state === 'failed' &&
      (delivery.retrySafe === true || delivery.final === true))
  );
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
    action:
      nextInconclusiveChecks >= MAX_INCONCLUSIVE_DELIVERY_CHECKS
        ? 'exhaust'
        : 'retry',
    inconclusiveChecks: nextInconclusiveChecks,
  };
}

export function deliveryNeedsAutomaticRecovery(message) {
  return (
    message?.deliveryRecoveryExhausted !== true &&
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
