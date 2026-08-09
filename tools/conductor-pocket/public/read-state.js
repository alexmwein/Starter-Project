export const READ_DWELL_MS = 600;
export const MAX_READ_RECEIPTS = 500;

function validIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function safeUnreadCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0) return 0;
  return count;
}

function validStatus(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 40 &&
    /^[a-z][a-z0-9_-]*$/i.test(value)
  );
}

function receiptKey(sessionId, responseId, unreadCount) {
  return `${sessionId}\u0000${responseId}\u0000${unreadCount}`;
}

export function normalizeUnreadHeads(value) {
  const heads = new Map();
  const ambiguous = new Set();
  if (!Array.isArray(value)) return heads;

  for (const item of value) {
    if (
      !item ||
      !validIdentifier(item.sessionId) ||
      !validIdentifier(item.workspaceId) ||
      !validStatus(item.status)
    ) {
      continue;
    }
    const unreadCount = safeUnreadCount(item.unreadCount);
    if (unreadCount === 0) continue;
    const responseId = validIdentifier(item.responseId)
      ? item.responseId
      : null;
    const normalized = {
      sessionId: item.sessionId,
      workspaceId: item.workspaceId,
      unreadCount,
      responseId,
      status: item.status,
    };
    const existing = heads.get(item.sessionId);
    if (
      existing &&
      (existing.workspaceId !== normalized.workspaceId ||
        existing.unreadCount !== normalized.unreadCount ||
        existing.responseId !== normalized.responseId ||
        existing.status !== normalized.status)
    ) {
      ambiguous.add(item.sessionId);
    } else if (!existing) {
      heads.set(item.sessionId, normalized);
    }
  }
  for (const sessionId of ambiguous) heads.delete(sessionId);
  return heads;
}

export function normalizeReadReceipts(value) {
  const receipts = new Map();
  if (!Array.isArray(value)) return receipts;

  for (const item of value.slice(0, MAX_READ_RECEIPTS * 2)) {
    if (
      !item ||
      !validIdentifier(item.sessionId) ||
      !validIdentifier(item.responseId)
    ) {
      continue;
    }
    const unreadCount = safeUnreadCount(item.unreadCount);
    if (unreadCount === 0) continue;
    const readAt = Number(item.readAt);
    if (!Number.isSafeInteger(readAt) || readAt <= 0) continue;
    const key = receiptKey(item.sessionId, item.responseId, unreadCount);
    const existing = receipts.get(key);
    if (!existing || readAt > existing.readAt) {
      receipts.set(key, {
        sessionId: item.sessionId,
        responseId: item.responseId,
        unreadCount,
        readAt,
      });
    }
  }
  return new Map(
    [...receipts.entries()]
      .sort((left, right) => right[1].readAt - left[1].readAt)
      .slice(0, MAX_READ_RECEIPTS),
  );
}

export function readReceiptSnapshot(receipts) {
  if (!(receipts instanceof Map)) return [];
  return [...receipts.values()]
    .filter(
      (item) =>
        item &&
        validIdentifier(item.sessionId) &&
        validIdentifier(item.responseId) &&
        safeUnreadCount(item.unreadCount) > 0 &&
        Number.isSafeInteger(item.readAt) &&
        item.readAt > 0,
    )
    .sort((left, right) => right.readAt - left.readAt)
    .slice(0, MAX_READ_RECEIPTS)
    .map(({ sessionId, responseId, unreadCount, readAt }) => ({
      sessionId,
      responseId,
      unreadCount: safeUnreadCount(unreadCount),
      readAt,
    }));
}

export function effectiveSessionUnreadCount({
  sessionId,
  nativeUnreadCount,
  unreadHeads,
  readReceipts,
  headsLoaded,
}) {
  const nativeCount = safeUnreadCount(nativeUnreadCount);
  if (!headsLoaded || !(unreadHeads instanceof Map)) return nativeCount;
  const head = unreadHeads.get(sessionId);
  if (!head) return nativeCount;
  const headCount = safeUnreadCount(head.unreadCount);
  if (headCount === 0) return nativeCount;
  if (headCount !== nativeCount) return Math.max(headCount, nativeCount);
  const receipt = readReceipts instanceof Map
    ? readReceipts.get(receiptKey(sessionId, head.responseId, headCount))
    : null;
  if (
    head.responseId &&
    receipt?.responseId === head.responseId &&
    safeUnreadCount(receipt.unreadCount) === headCount
  ) {
    return 0;
  }
  return headCount;
}

export function effectiveWorkspaceUnreadCount({
  workspaceId,
  nativeUnreadCount,
  unreadHeads,
  readReceipts,
  headsLoaded,
}) {
  const nativeCount = safeUnreadCount(nativeUnreadCount);
  if (!headsLoaded || !(unreadHeads instanceof Map)) return nativeCount;
  const heads = [...unreadHeads.values()].filter(
    (head) => head.workspaceId === workspaceId,
  );
  const representedCount = heads.reduce(
    (total, head) => total + safeUnreadCount(head.unreadCount),
    0,
  );
  if (representedCount !== nativeCount) {
    return Math.max(representedCount, nativeCount);
  }
  return heads.reduce((total, head) => {
    const receipt = readReceipts instanceof Map
      ? readReceipts.get(
          receiptKey(
            head.sessionId,
            head.responseId,
            safeUnreadCount(head.unreadCount),
          ),
        )
      : null;
    return total +
      (head.responseId &&
      receipt?.responseId === head.responseId &&
      safeUnreadCount(receipt.unreadCount) ===
        safeUnreadCount(head.unreadCount)
        ? 0
        : safeUnreadCount(head.unreadCount));
  }, 0);
}

function readableEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (entry) =>
      validIdentifier(entry?.responseId) &&
      ((entry.kind === 'assistant' && entry.importance === 'primary') ||
        (entry.kind === 'agent-error' && entry.retrying !== true)),
  );
}

export function latestReadableResponseId(entries) {
  return readableEntries(entries).at(-1)?.responseId || null;
}

export function readableResponseRange(entries, responseId) {
  if (!validIdentifier(responseId)) return null;
  const readable = readableEntries(entries);
  if (readable.at(-1)?.responseId !== responseId) return null;
  const matching = readable.filter(
    (entry) => entry.responseId === responseId,
  );
  if (matching.length === 0) return null;
  return {
    responseId,
    firstMessageId: String(matching[0].id),
    lastMessageId: String(matching.at(-1).id),
  };
}

export function emptyReadProgress() {
  return {
    key: null,
    gestureSequenceAtStart: 0,
    userInteracted: false,
    topSeen: false,
    bottomSince: null,
  };
}

export function advanceReadProgress(
  previous,
  sample,
  now,
  dwellMs = READ_DWELL_MS,
) {
  if (
    !sample?.eligible ||
    !validIdentifier(sample.key) ||
    !Number.isFinite(now) ||
    !Number.isFinite(dwellMs) ||
    dwellMs < 0
  ) {
    return { progress: emptyReadProgress(), acknowledge: false };
  }
  const gestureSequence = Number.isSafeInteger(sample.gestureSequence)
    ? sample.gestureSequence
    : 0;
  const prior = previous?.key === sample.key
    ? previous
    : {
        ...emptyReadProgress(),
        key: sample.key,
        gestureSequenceAtStart: gestureSequence,
      };
  const userInteracted =
    prior.userInteracted ||
    gestureSequence > prior.gestureSequenceAtStart;
  const topSeen =
    prior.topSeen ||
    sample.long !== true ||
    (userInteracted && sample.topVisible === true);
  const atReadPosition = sample.long === true
    ? topSeen && sample.bottomVisible === true
    : sample.fullyVisible === true;
  const bottomSince = atReadPosition
    ? prior.bottomSince ?? now
    : null;
  const progress = {
    key: sample.key,
    gestureSequenceAtStart: prior.gestureSequenceAtStart,
    userInteracted,
    topSeen,
    bottomSince,
  };
  return {
    progress,
    acknowledge:
      bottomSince !== null && now - bottomSince >= dwellMs,
  };
}
