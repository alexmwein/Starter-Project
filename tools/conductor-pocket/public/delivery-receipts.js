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
const PENDING_SNAPSHOT_VERSION = 2;
const TERMINAL_TOMBSTONE_LIMIT = 256;
const TERMINAL_TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DRAFT_CLAIM_LIMIT = 256;
const DRAFT_CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EDIT_CLAIM_MAX_AGE_MS = 5 * 60 * 1000;

function authorityString(value, maximum = 300) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : null;
}

function deliveryAttempt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function deliveryIdentityMatches(left, right) {
  return (
    left?.id === right?.id &&
    deliveryAttempt(left?.deliveryAttempt) ===
      deliveryAttempt(right?.deliveryAttempt) &&
    left?.activeDeliveryKey === right?.activeDeliveryKey
  );
}

function deliveryStateRank(message) {
  return {
    delivering: 0,
    confirming: 1,
    failed: 2,
    delivered: 3,
  }[message?.delivery] ?? 0;
}

function deliveryKeyTransitionAllows(current, candidate, transitions) {
  return transitions.some(
    (transition) =>
      transition?.id === current.id &&
      Number.isSafeInteger(transition.deliveryAttempt) &&
      transition.deliveryAttempt === current.deliveryAttempt &&
      transition.from === current.activeDeliveryKey &&
      transition.to === candidate.activeDeliveryKey,
  );
}

function deliveryStateTransitionAllows(current, candidate, transitions) {
  return transitions.some(
    (transition) =>
      transition?.id === current.id &&
      Number.isSafeInteger(transition.deliveryAttempt) &&
      transition.deliveryAttempt === current.deliveryAttempt &&
      transition.activeDeliveryKey === current.activeDeliveryKey &&
      transition.from === current.delivery &&
      transition.to === candidate.delivery,
  );
}

function newerPendingDelivery(
  current,
  candidate,
  deliveryKeyTransitions,
  deliveryStateTransitions,
) {
  if (!current) return candidate;
  if (candidate.deliveryAttempt !== current.deliveryAttempt) {
    return candidate.deliveryAttempt > current.deliveryAttempt
      ? candidate
      : current;
  }
  if (candidate.activeDeliveryKey !== current.activeDeliveryKey) {
    return deliveryKeyTransitionAllows(
      current,
      candidate,
      deliveryKeyTransitions,
    )
      ? candidate
      : current;
  }
  const candidateIsNewer =
    deliveryStateRank(candidate) >= deliveryStateRank(current);
  const newer =
    candidateIsNewer ||
    deliveryStateTransitionAllows(
      current,
      candidate,
      deliveryStateTransitions,
    )
      ? candidate
      : current;
  if (
    current.terminalActionClaim &&
    deliveryIdentityMatches(current, newer)
  ) {
    return {
      ...newer,
      terminalActionClaim: current.terminalActionClaim,
    };
  }
  return newer;
}

function normalizedEditClaim(value, now) {
  const token = authorityString(value?.token, 200);
  const at = Number(value?.at);
  if (
    value?.action !== 'edit' ||
    !token ||
    !Number.isFinite(at) ||
    at > now ||
    now - at > EDIT_CLAIM_MAX_AGE_MS
  ) {
    return null;
  }
  return { action: 'edit', token, at };
}

function normalizePendingSnapshot(raw, sanitize, now) {
  const sourceMessages = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.messages)
      ? raw.messages
      : [];
  const messages = sourceMessages
    .map((value) => sanitize(value))
    .filter(Boolean)
    .map((message) => {
      const terminalActionClaim = normalizedEditClaim(
        message.terminalActionClaim,
        now,
      );
      if (terminalActionClaim) {
        return { ...message, terminalActionClaim };
      }
      const normalized = { ...message };
      delete normalized.terminalActionClaim;
      return normalized;
    });
  const tombstones = (Array.isArray(raw?.tombstones) ? raw.tombstones : [])
    .map((value) => {
      const id = authorityString(value?.id, 500);
      const activeDeliveryKey = authorityString(value?.activeDeliveryKey, 200);
      const action = new Set(['delete', 'edit', 'resolved']).has(value?.action)
        ? value.action
        : null;
      const at = Number(value?.at);
      if (
        !id ||
        !activeDeliveryKey ||
        !action ||
        !Number.isFinite(at) ||
        at > now ||
        now - at > TERMINAL_TOMBSTONE_MAX_AGE_MS
      ) {
        return null;
      }
      return {
        id,
        activeDeliveryKey,
        deliveryAttempt: deliveryAttempt(value.deliveryAttempt),
        action,
        at,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.at - left.at)
    .slice(0, TERMINAL_TOMBSTONE_LIMIT);
  const draftClaims = (Array.isArray(raw?.draftClaims) ? raw.draftClaims : [])
    .map((value) => {
      const sessionId = authorityString(value?.sessionId, 300);
      const draftRevision = authorityString(value?.draftRevision, 200);
      const payloadFingerprint = authorityString(
        value?.payloadFingerprint,
        200,
      );
      const at = Number(value?.at);
      if (
        !sessionId ||
        !draftRevision ||
        !Number.isFinite(at) ||
        at > now ||
        now - at > DRAFT_CLAIM_MAX_AGE_MS
      ) {
        return null;
      }
      return {
        sessionId,
        draftRevision,
        payloadFingerprint,
        at,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.at - left.at)
    .slice(0, DRAFT_CLAIM_LIMIT);
  return {
    version: PENDING_SNAPSHOT_VERSION,
    messages,
    tombstones,
    draftClaims,
  };
}

function terminalTombstoneFor(message, action, now) {
  return {
    id: message.id,
    activeDeliveryKey: message.activeDeliveryKey,
    deliveryAttempt: deliveryAttempt(message.deliveryAttempt),
    action,
    at: now,
  };
}

function addTerminalTombstone(snapshot, message, action, now) {
  snapshot.tombstones = [
    terminalTombstoneFor(message, action, now),
    ...snapshot.tombstones.filter((item) => item.id !== message.id),
  ].slice(0, TERMINAL_TOMBSTONE_LIMIT);
}

function tombstoneBlocks(snapshot, candidate) {
  return snapshot.tombstones.some(
    (item) =>
      item.id === candidate.id &&
      deliveryAttempt(candidate.deliveryAttempt) <= item.deliveryAttempt,
  );
}

function mergePendingUpserts(
  snapshot,
  upserts,
  removeIds,
  deliveryKeyTransitions,
  deliveryStateTransitions,
  sanitize,
  now,
) {
  const merged = new Map(
    snapshot.messages.map((message) => [message.id, message]),
  );
  const removed = new Set(removeIds.filter((id) => typeof id === 'string'));
  for (const id of removed) {
    const current = merged.get(id);
    if (current) addTerminalTombstone(snapshot, current, 'resolved', now);
    merged.delete(id);
  }
  for (const value of upserts) {
    const candidate = sanitize(value);
    if (
      !candidate ||
      removed.has(candidate.id) ||
      tombstoneBlocks(snapshot, candidate)
    ) {
      continue;
    }
    merged.set(
      candidate.id,
      newerPendingDelivery(
        merged.get(candidate.id),
        candidate,
        deliveryKeyTransitions,
        deliveryStateTransitions,
      ),
    );
  }
  snapshot.messages = [...merged.values()];
}

export function pendingDeliverySnapshotTransition(
  raw,
  command,
  { sanitize = (value) => value, now = Date.now() } = {},
) {
  if (typeof sanitize !== 'function') {
    throw new TypeError('invalid_pending_delivery_sanitizer');
  }
  const snapshot = normalizePendingSnapshot(raw, sanitize, now);
  if (command?.type === 'mutate') {
    mergePendingUpserts(
      snapshot,
      Array.isArray(command.upserts) ? command.upserts : [],
      Array.isArray(command.removeIds) ? command.removeIds : [],
      Array.isArray(command.deliveryKeyTransitions)
        ? command.deliveryKeyTransitions
        : [],
      Array.isArray(command.deliveryStateTransitions)
        ? command.deliveryStateTransitions
        : [],
      sanitize,
      now,
    );
    return { snapshot, value: snapshot.messages };
  }
  if (command?.type === 'claim-draft-send') {
    const sessionId = authorityString(command.sessionId, 300);
    const draftRevision = authorityString(command.draftRevision, 200);
    const payloadFingerprint = authorityString(
      command.payloadFingerprint,
      200,
    );
    const candidate = sanitize(command.message);
    const alreadyClaimed = snapshot.draftClaims.some(
      (item) => {
        if (item.sessionId !== sessionId) return false;
        const sameRevision = item.draftRevision === draftRevision;
        const samePayload =
          payloadFingerprint &&
          item.payloadFingerprint === payloadFingerprint;
        if (sameRevision) {
          return (
            !payloadFingerprint ||
            !item.payloadFingerprint ||
            samePayload
          );
        }
        return samePayload;
      },
    );
    if (
      !sessionId ||
      !draftRevision ||
      !candidate ||
      candidate.sessionId !== sessionId ||
      alreadyClaimed ||
      tombstoneBlocks(snapshot, candidate)
    ) {
      return { snapshot, value: null };
    }
    snapshot.draftClaims = [
      { sessionId, draftRevision, payloadFingerprint, at: now },
      ...snapshot.draftClaims,
    ].slice(0, DRAFT_CLAIM_LIMIT);
    mergePendingUpserts(snapshot, [candidate], [], [], [], sanitize, now);
    return { snapshot, value: candidate };
  }
  if (command?.type === 'claim-terminal') {
    const action = command.action;
    if (!new Set(['retry', 'edit', 'delete']).has(action)) {
      throw new Error('delivery_action_invalid');
    }
    const index = snapshot.messages.findIndex(
      (candidate) => candidate.id === command.message?.id,
    );
    const candidate = index >= 0 ? snapshot.messages[index] : null;
    const matches =
      candidate?.delivery === 'failed' &&
      deliveryIdentityMatches(candidate, command.message) &&
      !candidate.terminalActionClaim &&
      (action === 'delete' ||
        action === 'edit' ||
        candidate.definitelyUnsent === true) &&
      (action !== 'retry' || candidate.retrySafe === true);
    if (!matches) return { snapshot, value: null };
    if (action === 'edit') {
      const claimToken = authorityString(command.claimToken, 200);
      if (!claimToken) throw new Error('delivery_edit_claim_invalid');
      const claimed = {
        ...candidate,
        terminalActionClaim: {
          action: 'edit',
          token: claimToken,
          at: now,
        },
      };
      snapshot.messages[index] = claimed;
      return { snapshot, value: claimed };
    }
    if (action === 'delete') {
      snapshot.messages.splice(index, 1);
      addTerminalTombstone(snapshot, candidate, 'delete', now);
      return { snapshot, value: candidate };
    }
    const claimed = {
      ...candidate,
      delivery: 'delivering',
      deliveryPhase: null,
      retrySafe: false,
      definitelyUnsent: false,
      deliveryRecoveryExhausted: false,
      errorCode: null,
      errorProjectName: null,
      deliveryAttempt: candidate.deliveryAttempt + 1,
    };
    snapshot.messages[index] = claimed;
    return { snapshot, value: claimed };
  }
  if (
    command?.type === 'finalize-edit' ||
    command?.type === 'release-edit'
  ) {
    const index = snapshot.messages.findIndex(
      (candidate) => candidate.id === command.message?.id,
    );
    const candidate = index >= 0 ? snapshot.messages[index] : null;
    const matches =
      candidate &&
      deliveryIdentityMatches(candidate, command.message) &&
      candidate.terminalActionClaim?.token === command.claimToken;
    if (!matches) return { snapshot, value: null };
    if (command.type === 'finalize-edit') {
      snapshot.messages.splice(index, 1);
      addTerminalTombstone(snapshot, candidate, 'edit', now);
      return { snapshot, value: candidate };
    }
    const released = { ...candidate };
    delete released.terminalActionClaim;
    snapshot.messages[index] = released;
    return { snapshot, value: released };
  }
  throw new Error('pending_delivery_transition_invalid');
}

export function pendingDeliveryMessages(
  raw,
  { sanitize = (value) => value, now = Date.now() } = {},
) {
  return normalizePendingSnapshot(raw, sanitize, now).messages;
}

export async function draftSendPayloadFingerprint({
  text,
  attachments = [],
}) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('secure_payload_fingerprint_unavailable');
  }
  const visiblePayload = JSON.stringify({
    text: String(text || '').trim(),
    attachments: attachments.map((attachment) => String(attachment?.id || '')),
  });
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(visiblePayload),
  );
  return `sha256-${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function claimedDraftClearIsAuthorized({
  claimedRevision,
  claimedPayloadFingerprint,
  currentRevision,
  currentPayloadFingerprint,
}) {
  return (
    typeof claimedRevision === 'string' &&
    claimedRevision.length > 0 &&
    typeof claimedPayloadFingerprint === 'string' &&
    claimedPayloadFingerprint.length > 0 &&
    currentRevision === claimedRevision &&
    currentPayloadFingerprint === claimedPayloadFingerprint
  );
}

export function mergeRecoveredDraftText(recoveredText, existingDraft) {
  const recovered = String(recoveredText || '');
  const existing = String(existingDraft || '');
  if (!recovered) return existing;
  if (!existing) return recovered;
  if (
    existing === recovered ||
    existing.startsWith(`${recovered}\n\n`)
  ) {
    return existing;
  }
  return `${recovered}\n\n${existing}`;
}

export function mergeRecoveredAttachmentItems(
  recoveredItems = [],
  currentItems = [],
) {
  const keyFor = (item) => item?.id || item?.localId || null;
  const currentByKey = new Map(
    currentItems
      .map((item) => [keyFor(item), item])
      .filter(([key]) => Boolean(key)),
  );
  const merged = [];
  const seen = new Set();
  for (const item of [...recoveredItems, ...currentItems]) {
    const key = keyFor(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(currentByKey.get(key) || item);
  }
  return merged;
}

export async function persistRecoveredDraftBeforeFinalizing({
  persistDraft,
  finalize,
  release,
}) {
  async function releaseSafely() {
    try {
      return Boolean(await release());
    } catch {
      return false;
    }
  }

  let persisted = false;
  try {
    persisted = (await persistDraft()) === true;
  } catch {
    persisted = false;
  }
  if (!persisted) {
    return {
      status: (await releaseSafely()) ? 'draft-failed' : 'release-failed',
      value: null,
    };
  }
  try {
    const value = await finalize();
    if (value) return { status: 'recovered', value };
  } catch {
    // The durable delivery is released below so recovery can be retried.
  }
  return {
    status: (await releaseSafely()) ? 'finalize-failed' : 'release-failed',
    value: null,
  };
}

export function workspaceProjectCollapsedCopy(projectName) {
  const safeName =
    typeof projectName === 'string' &&
    projectName.length > 0 &&
    projectName.length <= 160 &&
    projectName === projectName.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(projectName)
      ? projectName
      : null;
  if (!safeName) {
    return "A project is collapsed in Conductor's sidebar. Expand it to send.";
  }
  return `The '${safeName}' project is collapsed in Conductor's sidebar. Expand it to send.`;
}

export function deliveryStatusIsTerminal(delivery) {
  return (
    delivery?.state === 'delivered' ||
    (delivery?.state === 'failed' &&
      (delivery.retrySafe === true || delivery.final === true))
  );
}

export function terminalDeliveryActionDisposition(delivery) {
  if (delivery?.state === 'delivered') return 'resolved';
  if (
    delivery?.state === 'failed' &&
    deliveryStatusIsTerminal(delivery)
  ) {
    return 'actionable';
  }
  if (delivery?.state === 'pending') return 'pending';
  return 'unverified';
}

export function createDeliveryActionCoordinator({
  onChange = () => {},
} = {}) {
  if (typeof onChange !== 'function') {
    throw new TypeError('invalid_delivery_action_change_handler');
  }
  const active = new Map();
  return {
    current(key) {
      return active.get(key) || null;
    },
    async run(key, action, operation) {
      if (
        typeof key !== 'string' ||
        key.length === 0 ||
        typeof action !== 'string' ||
        action.length === 0 ||
        typeof operation !== 'function'
      ) {
        throw new TypeError('invalid_delivery_action');
      }
      if (active.has(key)) return { started: false, value: null };
      active.set(key, action);
      onChange(key, action);
      try {
        return { started: true, value: await operation() };
      } finally {
        active.delete(key);
        onChange(key, null);
      }
    },
  };
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
