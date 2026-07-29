const ACTIVITY_KINDS = new Set(['assistant', 'tool']);
const HIDDEN_KINDS = new Set(['status', 'tool-result', 'turn-result']);

function isRootMessage(message) {
  return !message.parentToolUseId;
}

function numericRowId(message) {
  const value = Number(message.rowId);
  return Number.isFinite(value) ? value : 0;
}

function completedTurns(messages, sessionStatus) {
  const turns = new Map();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message.turnId) continue;
    if (!turns.has(message.turnId)) {
      turns.set(message.turnId, {
        assistants: [],
        result: null,
        firstIndex: index,
      });
    }
    const turn = turns.get(message.turnId);
    if (message.kind === 'assistant' && isRootMessage(message)) {
      turn.assistants.push(message);
    } else if (message.kind === 'turn-result' && isRootMessage(message)) {
      turn.result = message;
    }
  }

  const orderedTurns = [...turns.entries()].sort(
    (left, right) => left[1].firstIndex - right[1].firstIndex,
  );
  const finalRows = new Map();

  for (const [turnId, turn] of orderedTurns) {
    if (turn.result?.state === 'failed') continue;
    if (!turn.result && sessionStatus !== 'idle') continue;
    let candidates = turn.assistants;
    if (turn.result) {
      const resultRowId = numericRowId(turn.result);
      candidates = candidates.filter(
        (message) => numericRowId(message) < resultRowId,
      );
    }
    if (candidates.length === 0) continue;
    finalRows.set(
      turnId,
      Math.max(...candidates.map((message) => numericRowId(message))),
    );
  }

  return finalRows;
}

function activeTurnId(messages, sessionStatus) {
  if (sessionStatus !== 'working') return null;
  const terminalTurns = new Set(
    messages
      .filter(
        (message) =>
          message.kind === 'turn-result' &&
          message.turnId &&
          isRootMessage(message),
      )
      .map((message) => message.turnId),
  );
  return [...messages]
    .reverse()
    .find(
      (message) =>
        ACTIVITY_KINDS.has(message.kind) &&
        message.turnId &&
        isRootMessage(message) &&
        !terminalTurns.has(message.turnId),
    )?.turnId || null;
}

function resolvedToolState(message, toolResults) {
  return toolResults.get(message.toolCallId)?.state || message.state || 'running';
}

function activityEntry(turnId, firstMessage) {
  return {
    id: `activity:${turnId}:${firstMessage.id}`,
    kind: 'activity',
    turnId,
    items: [],
    messageCount: 0,
    toolCount: 0,
    running: false,
  };
}

/**
 * Mirrors Conductor's focused transcript hierarchy:
 * completed turns keep their final root answer prominent while intermediate
 * root prose and successful tool calls become a compact disclosure.
 */
export function buildFocusedTranscript(
  messages,
  { sessionStatus = 'unknown' } = {},
) {
  const toolResults = new Map(
    messages
      .filter((message) => message.kind === 'tool-result' && message.toolCallId)
      .map((message) => [message.toolCallId, message]),
  );
  const toolCallIds = new Set(
    messages
      .filter((message) => message.kind === 'tool' && message.toolCallId)
      .map((message) => message.toolCallId),
  );
  const finalRows = completedTurns(messages, sessionStatus);
  const activeTurn = activeTurnId(messages, sessionStatus);
  const entries = [];
  let activity = null;

  const flushActivity = () => {
    if (!activity) return;
    entries.push(activity);
    activity = null;
  };

  const appendActivity = (message) => {
    if (!activity || activity.turnId !== message.turnId) {
      flushActivity();
      activity = activityEntry(message.turnId, message);
    }
    activity.items.push(message);
    if (message.kind === 'assistant') activity.messageCount += 1;
    if (message.kind === 'tool') {
      activity.toolCount += 1;
      if (resolvedToolState(message, toolResults) === 'running') {
        activity.running = true;
      }
    }
  };

  for (const message of messages) {
    if (HIDDEN_KINDS.has(message.kind)) continue;

    if (
      message.kind === 'assistant' &&
      message.turnId &&
      isRootMessage(message)
    ) {
      const finalRow = finalRows.get(message.turnId);
      if (finalRow != null && numericRowId(message) === finalRow) {
        flushActivity();
        entries.push({ ...message, importance: 'primary' });
      } else {
        appendActivity({ ...message, importance: 'progress' });
      }
      continue;
    }

    if (message.kind === 'tool' && message.turnId && isRootMessage(message)) {
      const state = resolvedToolState(message, toolResults);
      if (state === 'failed') {
        flushActivity();
        entries.push({ ...message, resolvedState: state });
      } else {
        appendActivity({ ...message, resolvedState: state });
      }
      continue;
    }

    if (message.kind === 'tool-failure') {
      if (message.toolCallId && toolCallIds.has(message.toolCallId)) continue;
      flushActivity();
      entries.push({ ...message, kind: 'agent-error' });
      continue;
    }

    if (message.kind === 'assistant' && !isRootMessage(message)) {
      continue;
    }

    if (ACTIVITY_KINDS.has(message.kind) && message.turnId) {
      appendActivity(message);
      continue;
    }

    flushActivity();
    entries.push(message);
  }

  flushActivity();
  if (activeTurn) {
    const activeEntry = [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.kind === 'activity' && entry.turnId === activeTurn,
      );
    if (activeEntry) activeEntry.running = true;
  }
  return { entries, toolResults };
}

function countPhrase(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function activityLabel(activity) {
  const parts = [];
  if (activity.toolCount > 0) {
    parts.push(countPhrase(activity.toolCount, 'tool call', 'tool calls'));
  }
  if (activity.messageCount > 0) {
    parts.push(countPhrase(activity.messageCount, 'message', 'messages'));
  }
  return parts.join(', ') || 'Activity';
}
