import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityLabel,
  buildFocusedTranscript,
} from '../public/transcript-focus.js';

const user = (id, rowId, turnId) => ({
  id,
  rowId,
  kind: 'user',
  text: id,
  turnId,
});
const assistant = (id, rowId, turnId, parentToolUseId = null) => ({
  id,
  rowId,
  kind: 'assistant',
  text: id,
  turnId,
  parentToolUseId,
});

test('completed turns collapse progress and keep every final text block prominent', () => {
  const messages = [
    user('question', 1, 'turn-1'),
    assistant('progress', 2, 'turn-1'),
    {
      id: 'tool',
      rowId: 3,
      kind: 'tool',
      toolCallId: 'call-1',
      state: 'running',
      turnId: 'turn-1',
    },
    {
      id: 'tool-result',
      rowId: 4,
      kind: 'tool-result',
      toolCallId: 'call-1',
      state: 'completed',
      turnId: 'turn-1',
    },
    assistant('final-block-a', 5, 'turn-1'),
    assistant('final-block-b', 5, 'turn-1'),
    {
      id: 'result',
      rowId: 6,
      kind: 'turn-result',
      state: 'complete',
      turnId: 'turn-1',
    },
  ];

  const { entries } = buildFocusedTranscript(messages, {
    sessionStatus: 'idle',
  });

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['user', 'activity', 'assistant', 'assistant'],
  );
  assert.equal(entries[1].messageCount, 1);
  assert.equal(entries[1].toolCount, 1);
  assert.equal(entries[1].running, false);
  assert.equal(entries[2].importance, 'primary');
  assert.equal(entries[3].importance, 'primary');
  assert.equal(activityLabel(entries[1]), '1 tool call, 1 message');
});

test('an active turn has no manufactured final answer', () => {
  const { entries } = buildFocusedTranscript(
    [
      user('question', 1, 'turn-active'),
      assistant('first update', 2, 'turn-active'),
      assistant('newest update', 3, 'turn-active'),
    ],
    { sessionStatus: 'working' },
  );

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['user', 'activity'],
  );
  assert.equal(entries[1].messageCount, 2);
  assert.equal(entries[1].running, true);
  assert.equal(
    entries.some(
      (entry) => entry.kind === 'assistant' && entry.importance === 'primary',
    ),
    false,
  );
});

test('a terminal marker promotes the newest root answer on the next refresh', () => {
  const partial = [
    user('question', 1, 'turn-streaming'),
    assistant('working update', 2, 'turn-streaming'),
  ];
  assert.equal(
    buildFocusedTranscript(partial, { sessionStatus: 'working' }).entries[1]
      .kind,
    'activity',
  );

  const complete = [
    ...partial,
    assistant('finished answer', 3, 'turn-streaming'),
    {
      id: 'result',
      rowId: 4,
      kind: 'turn-result',
      state: 'complete',
      turnId: 'turn-streaming',
    },
  ];
  const { entries } = buildFocusedTranscript(complete, {
    sessionStatus: 'idle',
  });
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.text || null]),
    [
      ['user', 'question'],
      ['activity', null],
      ['assistant', 'finished answer'],
    ],
  );
});

test('nested research prose is suppressed while failures always punch through', () => {
  const { entries } = buildFocusedTranscript(
    [
      user('question', 1, 'turn-research'),
      assistant('nested replay', 2, 'turn-research', 'spawn-1'),
      {
        id: 'failed-tool',
        rowId: 3,
        kind: 'tool',
        toolCallId: 'call-failed',
        state: 'running',
        turnId: 'turn-research',
      },
      {
        id: 'failed-result',
        rowId: 4,
        kind: 'tool-result',
        toolCallId: 'call-failed',
        state: 'failed',
        turnId: 'turn-research',
      },
      {
        id: 'background-error',
        rowId: 5,
        kind: 'agent-error',
        title: 'Background action failed',
        turnId: 'turn-research',
        parentToolUseId: 'spawn-1',
      },
    ],
    { sessionStatus: 'error' },
  );

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['user', 'tool', 'agent-error'],
  );
  assert.equal(entries[1].resolvedState, 'failed');
  assert.equal(
    entries.some((entry) => entry.text === 'nested replay'),
    false,
  );
});

test('markerless turns remain progress even when a later turn starts', () => {
  const { entries } = buildFocusedTranscript(
    [
      user('first question', 1, 'turn-old'),
      assistant('older answer', 2, 'turn-old'),
      user('new question', 3, 'turn-new'),
      assistant('new progress', 4, 'turn-new'),
    ],
    { sessionStatus: 'working' },
  );

  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.text || null]),
    [
      ['user', 'first question'],
      ['activity', null],
      ['user', 'new question'],
      ['activity', null],
    ],
  );
});

test('an idle markerless transcript uses its last root message as a fallback final', () => {
  const { entries } = buildFocusedTranscript(
    [
      user('question', 1, 'turn-idle'),
      assistant('progress', 2, 'turn-idle'),
      assistant('answer', 3, 'turn-idle'),
    ],
    { sessionStatus: 'idle' },
  );

  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.text || null]),
    [
      ['user', 'question'],
      ['activity', null],
      ['assistant', 'answer'],
    ],
  );
});

test('an orphaned failed tool result becomes a sanitized visible error', () => {
  const orphan = {
    id: 'orphan-failure',
    rowId: 4,
    kind: 'tool-failure',
    toolCallId: 'missing-call',
    title: 'Tool action failed',
    turnId: 'turn-failed',
  };
  const orphaned = buildFocusedTranscript([orphan]).entries;
  assert.deepEqual(
    orphaned.map((entry) => [entry.kind, entry.title]),
    [['agent-error', 'Tool action failed']],
  );

  const matched = buildFocusedTranscript([
    {
      id: 'tool',
      rowId: 2,
      kind: 'tool',
      toolCallId: 'present-call',
      state: 'running',
      turnId: 'turn-failed',
    },
    {
      id: 'failed-result',
      rowId: 3,
      kind: 'tool-result',
      toolCallId: 'present-call',
      state: 'failed',
      turnId: 'turn-failed',
    },
    { ...orphan, toolCallId: 'present-call' },
  ]).entries;
  assert.deepEqual(matched.map((entry) => entry.kind), ['tool']);
  assert.equal(matched[0].resolvedState, 'failed');
});

test('a nested failed result does not finish the still-working root turn', () => {
  const { entries } = buildFocusedTranscript(
    [
      assistant('root progress', 2, 'turn-research'),
      {
        id: 'nested-result',
        rowId: 3,
        kind: 'turn-result',
        state: 'failed',
        turnId: 'turn-research',
        parentToolUseId: 'spawn-research',
      },
    ],
    { sessionStatus: 'working' },
  );

  assert.equal(entries[0].kind, 'activity');
  assert.equal(entries[0].running, true);
});
