import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConductorDatabase } from '../src/conductor-db.mjs';

async function createConfirmationFixture(context, databaseOptions = {}) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-confirmation-db-'),
  );
  const dbPath = path.join(directory, 'conductor.db');
  const writable = new DatabaseSync(dbPath);
  writable.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      name TEXT,
      hidden INTEGER DEFAULT 0
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      repository_id TEXT,
      workspace_name TEXT,
      secondary_directory_name TEXT,
      placeholder_branch_name TEXT,
      branch TEXT,
      directory_name TEXT,
      workspace_path TEXT,
      sandbox_provider TEXT,
      state TEXT,
      unread INTEGER,
      pinned_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      title TEXT,
      agent_type TEXT,
      model TEXT,
      status TEXT,
      unread_count INTEGER,
      created_at TEXT,
      updated_at TEXT,
      last_user_message_at TEXT,
      context_used_percent REAL,
      queue_paused_at TEXT,
      is_hidden INTEGER DEFAULT 0
    );
    CREATE TABLE session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      role TEXT,
      content TEXT,
      created_at TEXT,
      sent_at TEXT,
      cancelled_at TEXT,
      model TEXT,
      turn_id TEXT
    );
    CREATE INDEX idx_session_messages_sent_at
      ON session_messages(session_id, sent_at);
    CREATE INDEX idx_session_messages_cancelled_at
      ON session_messages(session_id, cancelled_at);

    INSERT INTO repos (id, name, hidden)
    VALUES ('repo-1', 'Quickstart', 0);
    INSERT INTO workspaces
      (
        id,
        repository_id,
        workspace_name,
        secondary_directory_name,
        placeholder_branch_name,
        branch,
        directory_name,
        workspace_path,
        sandbox_provider,
        state,
        unread,
        updated_at
      )
    VALUES
      (
        'workspace-1',
        'repo-1',
        NULL,
        'visible-workspace-name',
        'folder-codename',
        'feature/pocket',
        'folder-codename',
        '${directory.replaceAll("'", "''")}',
        'local',
        'ready',
        0,
        '2026-01-01'
      );
    INSERT INTO sessions
      (id, workspace_id, title, agent_type, model, status, unread_count, created_at, updated_at, is_hidden)
    VALUES
      ('session-1', 'workspace-1', 'First chat', 'codex', 'gpt-test', 'working', 0, '2026-01-01', '2026-01-01', 0),
      ('session-2', 'workspace-1', 'Second chat', 'codex', 'gpt-test', 'working', 0, '2026-01-01', '2026-01-01', 0);
  `);
  const database = new ConductorDatabase(dbPath, databaseOptions);
  context.after(async () => {
    database.close();
    writable.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const insert = writable.prepare(`
    INSERT INTO session_messages
      (id, session_id, role, content, created_at, sent_at, cancelled_at, model, turn_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'gpt-test', 'turn-1')
  `);
  return { database, insert, writable };
}

test('database adapter exposes sanitized chat events without tool payloads', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-pocket-db-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'conductor.db');
  const writable = new DatabaseSync(dbPath);
  writable.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      name TEXT,
      hidden INTEGER DEFAULT 0
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      repository_id TEXT,
      workspace_name TEXT,
      secondary_directory_name TEXT,
      placeholder_branch_name TEXT,
      branch TEXT,
      directory_name TEXT,
      workspace_path TEXT,
      sandbox_provider TEXT,
      state TEXT,
      unread INTEGER,
      pinned_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      title TEXT,
      agent_type TEXT,
      model TEXT,
      status TEXT,
      unread_count INTEGER,
      created_at TEXT,
      updated_at TEXT,
      last_user_message_at TEXT,
      context_used_percent REAL,
      queue_paused_at TEXT,
      is_hidden INTEGER DEFAULT 0
    );
    CREATE TABLE session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      role TEXT,
      content TEXT,
      created_at TEXT,
      sent_at TEXT,
      cancelled_at TEXT,
      model TEXT,
      turn_id TEXT
    );
    CREATE INDEX idx_session_messages_sent_at
      ON session_messages(session_id, sent_at);
    CREATE INDEX idx_session_messages_cancelled_at
      ON session_messages(session_id, cancelled_at);
  `);
  writable
    .prepare('INSERT INTO repos (id, name, hidden) VALUES (?, ?, 0)')
    .run('repo-1', 'Quickstart');
  writable
    .prepare(`
      INSERT INTO workspaces
        (id, repository_id, workspace_name, branch, directory_name, state, unread, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ready', 0, ?)
    `)
    .run('workspace-1', 'repo-1', 'Pocket test', 'feature/pocket', 'test', '2026-01-01');
  writable
    .prepare(`
      INSERT INTO sessions
        (id, workspace_id, title, agent_type, model, status, unread_count, created_at, updated_at, last_user_message_at, is_hidden)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)
    `)
    .run(
      'session-1',
      'workspace-1',
      'Test chat',
      'codex',
      'gpt-test',
      'working',
      '2026-01-01',
      '2026-01-01',
      '2026-01-01',
    );
  const insert = writable.prepare(`
    INSERT INTO session_messages
      (id, session_id, role, content, created_at, sent_at, model, turn_id)
    VALUES (?, 'session-1', ?, ?, ?, ?, 'gpt-test', 'turn-1')
  `);
  insert.run('user-1', 'user', 'Hello from the phone', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  insert.run(
    'assistant-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello back.' }] },
    }),
    '2026-01-01T00:00:01Z',
    null,
  );
  insert.run(
    'tool-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-call-1',
            name: 'read_secret_file',
            input: { path: '/private/secret', token: 'must-not-leak' },
          },
        ],
      },
    }),
    '2026-01-01T00:00:02Z',
    null,
  );
  insert.run(
    'tool-result-1',
    'assistant',
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-call-1',
            content: 'highly sensitive output',
          },
        ],
      },
    }),
    '2026-01-01T00:00:03Z',
    null,
  );
  insert.run(
    'tool-failed-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-call-failed-1',
            name: 'private_failed_tool',
            input: { token: 'private failed input' },
          },
        ],
      },
    }),
    '2026-01-01T00:00:03Z',
    null,
  );
  insert.run(
    'tool-failed-result-1',
    'assistant',
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-call-failed-1',
            is_error: true,
            content: 'private root failure output',
          },
        ],
      },
    }),
    '2026-01-01T00:00:03Z',
    null,
  );
  insert.run(
    'nested-text-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'spawn-research-1',
      message: {
        content: [
          {
            type: 'text',
            text: 'Duplicated nested research should never be a main message.',
          },
        ],
      },
    }),
    '2026-01-01T00:00:04Z',
    null,
  );
  insert.run(
    'nested-malformed-error-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'spawn-research-1',
      is_error: true,
      message: {
        content: [
          {
            type: 'text',
            text: 'PRIVATE_NESTED_MALFORMED_ERROR_TEXT',
          },
        ],
      },
    }),
    '2026-01-01T00:00:04Z',
    null,
  );
  insert.run(
    'nested-failure-1',
    'assistant',
    JSON.stringify({
      type: 'user',
      parent_tool_use_id: 'spawn-research-1',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'nested-call-1',
            is_error: true,
            content: 'private nested failure output',
          },
        ],
      },
    }),
    '2026-01-01T00:00:05Z',
    null,
  );
  insert.run(
    'assistant-final-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'This is the finished answer.' }],
      },
    }),
    '2026-01-01T00:00:06Z',
    null,
  );
  insert.run(
    'turn-result-1',
    'assistant',
    JSON.stringify({
      type: 'result',
      is_error: false,
    }),
    '2026-01-01T00:00:07Z',
    null,
  );
  writable.close();

  const database = new ConductorDatabase(dbPath);
  context.after(() => database.close());
  const workspaces = database.listWorkspaces();
  assert.equal(workspaces[0].name, 'Pocket test');
  assert.equal(workspaces[0].workingCount, 1);
  assert.equal(database.listSessions('workspace-1')[0].title, 'Test chat');

  const result = database.listMessages('session-1');
  assert.equal(result.messages.some((message) => message.text === 'Hello back.'), true);
  assert.equal(
    result.messages.some((message) => message.name === 'Read Secret File'),
    true,
  );
  assert.equal(
    result.messages.some(
      (message) =>
        message.text ===
        'Duplicated nested research should never be a main message.',
    ),
    false,
  );
  assert.equal(
    result.messages.some(
      (message) =>
        message.kind === 'agent-error' &&
        message.code === 'background_action_failed',
    ),
    true,
  );
  assert.equal(
    result.messages.some(
      (message) =>
        message.kind === 'tool-failure' &&
        message.code === 'tool_action_failed',
    ),
    true,
  );
  assert.equal(
    result.messages.some(
      (message) =>
        message.kind === 'turn-result' && message.state === 'complete',
    ),
    true,
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('must-not-leak'), false);
  assert.equal(serialized.includes('highly sensitive output'), false);
  assert.equal(serialized.includes('private nested failure output'), false);
  assert.equal(serialized.includes('private root failure output'), false);
  assert.equal(serialized.includes('private failed input'), false);
  assert.equal(
    serialized.includes('PRIVATE_NESTED_MALFORMED_ERROR_TEXT'),
    false,
  );
});

test('workspace routes use the visible Conductor name instead of the folder codename', async (context) => {
  const { database } = await createConfirmationFixture(context);
  assert.equal(database.listWorkspaces()[0].name, 'visible workspace name');
  assert.equal(
    database.listRecentSessions(1)[0].workspaceName,
    'visible workspace name',
  );
  assert.equal(
    database.listRecentSessions(1)[0].repositoryName,
    'Quickstart',
  );
  assert.equal(
    database.getSessionRoute('session-1').workspaceName,
    'visible workspace name',
  );
  assert.equal(
    database.getSessionRoute('session-1').repositoryName,
    'Quickstart',
  );
  assert.equal(database.listLocalWorkspacePaths().length, 1);
  assert.equal(path.isAbsolute(database.listLocalWorkspacePaths()[0]), true);
});

test('session lists promote the newest activity across user, assistant, and creation timestamps', async (context) => {
  const { database, writable } = await createConfirmationFixture(context);
  writable.exec(`
    UPDATE sessions
      SET created_at = '2026-01-01T00:00:00Z',
          updated_at = '2026-01-01 00:04:00',
          last_user_message_at = '2026-01-01T00:01:00Z'
      WHERE id = 'session-1';
    UPDATE sessions
      SET created_at = '2026-01-01T00:00:00Z',
          updated_at = '2026-01-01 00:03:00',
          last_user_message_at = '2026-01-01T00:03:00Z'
      WHERE id = 'session-2';
    INSERT INTO sessions
      (id, workspace_id, title, agent_type, model, status, unread_count, created_at, updated_at, last_user_message_at, is_hidden)
    VALUES
      ('session-3', 'workspace-1', 'Newest chat', 'codex', 'gpt-test', 'idle', 0,
       '2026-01-01T00:05:00Z', '2026-01-01T00:02:00Z', NULL, 0),
      ('session-hidden', 'workspace-1', 'Hidden chat', 'codex', 'gpt-test', 'idle', 0,
       '2026-01-01T00:10:00Z', '2026-01-01T00:10:00Z', NULL, 1);
  `);

  const workspaceSessions = database.listSessions('workspace-1');
  assert.deepEqual(
    workspaceSessions.map(({ id }) => id),
    ['session-3', 'session-1', 'session-2'],
  );
  assert.deepEqual(
    workspaceSessions.map(({ activityAt }) => activityAt),
    [
      '2026-01-01T00:05:00.000Z',
      '2026-01-01T00:04:00.000Z',
      '2026-01-01T00:03:00.000Z',
    ],
  );

  const recentSessions = database.listRecentSessions(3);
  assert.deepEqual(
    recentSessions.map(({ id }) => id),
    ['session-3', 'session-1', 'session-2'],
  );
  assert.deepEqual(
    recentSessions.map(({ activityAt }) => activityAt),
    [
      '2026-01-01T00:05:00.000Z',
      '2026-01-01T00:04:00.000Z',
      '2026-01-01T00:03:00.000Z',
    ],
  );
  assert.equal(
    database.listWorkspaces()[0].activityAt,
    '2026-01-01T00:05:00.000Z',
  );
});

test('a visible queued user row can be refreshed as sent without a new row id', async (context) => {
  const { database, insert, writable } = await createConfirmationFixture(context);
  insert.run(
    'queued-refresh',
    'session-1',
    'user',
    'Queued then sent',
    '2026-01-01T00:00:01Z',
    null,
    null,
  );
  const queued = database.findExactUserMessageAfter(
    'session-1',
    0,
    'Queued then sent',
  );

  assert.deepEqual(
    database.getVisibleUserMessage('session-1', queued.rowId),
    queued,
  );
  assert.equal(
    database.getVisibleUserMessage('session-2', queued.rowId),
    null,
  );
  assert.equal(database.getVisibleUserMessage('session-1', 0), null);

  const sentAt = '2026-01-01T00:00:02Z';
  writable
    .prepare('UPDATE session_messages SET sent_at = ? WHERE rowid = ?')
    .run(sentAt, queued.rowId);
  const sent = database.getVisibleUserMessage('session-1', queued.rowId);
  assert.equal(sent.id, queued.id);
  assert.equal(sent.rowId, queued.rowId);
  assert.equal(sent.sentAt, sentAt);
  assert.equal(sent.queued, false);

  writable
    .prepare('UPDATE session_messages SET cancelled_at = ? WHERE rowid = ?')
    .run('2026-01-01T00:00:03Z', queued.rowId);
  assert.equal(
    database.getVisibleUserMessage('session-1', queued.rowId),
    null,
  );
});

test('send confirmation associates an immediate stale steer rejection with its user row', async (context) => {
  const { database, insert } = await createConfirmationFixture(context);
  insert.run(
    'rejected-user',
    'session-1',
    'user',
    'Continue the work',
    '2026-01-01T00:00:01Z',
    '2026-01-01T00:00:01Z',
    null,
  );
  insert.run(
    'rejected-error',
    'session-1',
    'assistant',
    JSON.stringify({
      type: 'error',
      content:
        'Cannot steer: no active turn. Start a turn with runStreamed() first.',
    }),
    '2026-01-01T00:00:01.100Z',
    '2026-01-01T00:00:01.100Z',
    null,
  );
  const match = database.findExactUserMessageAfter(
    'session-1',
    0,
    'Continue the work',
  );
  assert.deepEqual(
    database.findImmediateSendRejection('session-1', match),
    {
      code: 'conductor_turn_rejected',
      rowId: match.rowId + 1,
    },
  );

  insert.run(
    'next-user',
    'session-1',
    'user',
    'New turn',
    '2026-01-01T00:00:02Z',
    '2026-01-01T00:00:02Z',
    null,
  );
  insert.run(
    'later-error',
    'session-1',
    'assistant',
    JSON.stringify({ type: 'error', content: 'Cannot steer: no active turn.' }),
    '2026-01-01T00:00:02.100Z',
    '2026-01-01T00:00:02.100Z',
    null,
  );
  assert.equal(
    database.findImmediateSendRejection('session-1', match)?.rowId,
    match.rowId + 1,
  );
});

test('confirmed delivery state distinguishes a visible row from later cancellation', async (context) => {
  const { database, insert, writable } = await createConfirmationFixture(context);
  insert.run(
    'delivery-user',
    'session-1',
    'user',
    'Send once',
    '2026-01-01T00:00:01Z',
    '2026-01-01T00:00:01Z',
    null,
  );
  const match = database.findExactUserMessageAfter(
    'session-1',
    0,
    'Send once',
  );
  assert.equal(
    database.getDeliveredMessageState('session-1', match.rowId),
    'visible',
  );
  writable
    .prepare('UPDATE session_messages SET cancelled_at = ? WHERE rowid = ?')
    .run('2026-01-01T00:00:02Z', match.rowId);
  assert.equal(
    database.getDeliveredMessageState('session-1', match.rowId),
    'cancelled',
  );
  assert.equal(
    database.getDeliveredMessageState('session-1', match.rowId + 100),
    'missing',
  );
});

test('unread heads bind completion status and match the focused visible response', async (context) => {
  const { database, insert, writable } = await createConfirmationFixture(context);
  writable
    .prepare(
      'UPDATE sessions SET unread_count = 1, updated_at = ? WHERE id = ?',
    )
    .run('2026-01-01T00:00:01Z', 'session-1');
  insert.run(
    'root-response-1',
    'session-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Readable answer' }] },
    }),
    '2026-01-01T00:00:01Z',
    null,
    null,
  );
  insert.run(
    'nested-response-1',
    'session-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'nested-tool',
      message: { content: [{ type: 'text', text: 'Nested research' }] },
    }),
    '2026-01-01T00:00:02Z',
    null,
    null,
  );

  assert.deepEqual(database.listUnreadSessionHeads(), [
    {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      unreadCount: 1,
      responseId: null,
      status: 'working',
    },
  ]);

  writable
    .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
    .run('idle', '2026-01-01T00:00:03Z', 'session-1');

  assert.deepEqual(database.listUnreadSessionHeads(), [
    {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      unreadCount: 1,
      responseId: 'root-response-1',
      status: 'idle',
    },
  ]);
  assert.equal(
    database
      .listMessages('session-1')
      .messages.find((message) => message.text === 'Readable answer')
      .responseId,
    'root-response-1',
  );

  insert.run(
    'failed-result-1',
    'session-1',
    'assistant',
    JSON.stringify({
      type: 'result',
      is_error: true,
      error: 'private provider detail',
    }),
    '2026-01-01T00:00:03Z',
    null,
    null,
  );
  assert.equal(
    database.listUnreadSessionHeads()[0].responseId,
    'failed-result-1',
  );

  insert.run(
    'normal-tool-use-1',
    'session-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'normal-tool-call-1',
          name: 'Bash',
          input: { private: 'not exposed' },
        }],
      },
    }),
    '2026-01-01T00:00:04Z',
    null,
    null,
  );
  insert.run(
    'normal-tool-failure-1',
    'session-1',
    'assistant',
    JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'normal-tool-call-1',
          is_error: true,
          content: 'private failure output',
        }],
      },
    }),
    '2026-01-01T00:00:05Z',
    null,
    null,
  );
  assert.equal(
    database.listUnreadSessionHeads()[0].responseId,
    'failed-result-1',
  );

  insert.run(
    'orphan-tool-failure-1',
    'session-1',
    'assistant',
    JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'orphan-tool-call-1',
          is_error: true,
          content: 'private orphan output',
        }],
      },
    }),
    '2026-01-01T00:00:06Z',
    null,
    null,
  );
  assert.equal(
    database.listUnreadSessionHeads()[0].responseId,
    'orphan-tool-failure-1',
  );

  writable
    .prepare('UPDATE session_messages SET cancelled_at = ? WHERE id = ?')
    .run('2026-01-01T00:00:07Z', 'orphan-tool-failure-1');
  assert.equal(
    database.listUnreadSessionHeads()[0].responseId,
    'failed-result-1',
  );
});

test('an unrelated chat write retains cached unread response heads', async (context) => {
  const scans = [];
  const { database, insert, writable } = await createConfirmationFixture(
    context,
    { onReadableHeadScan: (sessionId) => scans.push(sessionId) },
  );
  writable
    .prepare(
      'UPDATE sessions SET status = ?, unread_count = 1, updated_at = ? WHERE id = ?',
    )
    .run('idle', '2026-01-01T00:00:01Z', 'session-1');
  insert.run(
    'cached-root-response',
    'session-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Cached answer' }] },
    }),
    '2026-01-01T00:00:01Z',
    null,
    null,
  );

  assert.equal(
    database.listUnreadSessionHeads()[0].responseId,
    'cached-root-response',
  );
  assert.deepEqual(scans, ['session-1']);
  scans.length = 0;

  insert.run(
    'unrelated-active-message',
    'session-2',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Still working elsewhere' }] },
    }),
    '2026-01-01T00:00:02Z',
    null,
    null,
  );

  assert.equal(
    database.listUnreadSessionHeads()[0].responseId,
    'cached-root-response',
  );
  assert.deepEqual(scans, []);
});

test('unread head caching detects an exact cancellation-set swap', async (context) => {
  const scans = [];
  const { database, insert, writable } = await createConfirmationFixture(
    context,
    { onReadableHeadScan: (sessionId) => scans.push(sessionId) },
  );
  writable
    .prepare(
      'UPDATE sessions SET status = ?, unread_count = 1, updated_at = ? WHERE id = ?',
    )
    .run('idle', '2026-01-01T00:00:01Z', 'session-1');
  for (const [id, cancelledAt] of [
    ['swap-response-1', '2026-01-01T00:01:01Z'],
    ['swap-response-2', null],
    ['swap-response-3', null],
    ['swap-response-4', '2026-01-01T00:01:04Z'],
  ]) {
    insert.run(
      id,
      'session-1',
      'assistant',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: id }] },
      }),
      '2026-01-01T00:00:01Z',
      null,
      cancelledAt,
    );
  }
  assert.equal(
    database.listUnreadSessionHeads()[0].responseId,
    'swap-response-3',
  );
  assert.deepEqual(scans, ['session-1']);
  scans.length = 0;

  writable.exec(`
    BEGIN;
    UPDATE session_messages
      SET cancelled_at = NULL
      WHERE id IN ('swap-response-1', 'swap-response-4');
    UPDATE session_messages
      SET cancelled_at = '2026-01-01T00:02:00Z'
      WHERE id IN ('swap-response-2', 'swap-response-3');
    COMMIT;
  `);

  assert.equal(
    database.listUnreadSessionHeads()[0].responseId,
    'swap-response-4',
  );
  assert.deepEqual(scans, ['session-1']);
});

test('cancelled rows stay hidden while the high-water cursor still fences them', async (context) => {
  const { database, insert } = await createConfirmationFixture(context);
  insert.run(
    'visible-queued',
    'session-1',
    'user',
    'Visible queued message',
    '2026-01-01T00:00:01Z',
    null,
    null,
  );
  const visibleCursor = database.getSessionMessageCursor('session-1');
  insert.run(
    'cancelled-newer',
    'session-1',
    'user',
    'Cancelled message',
    '2026-01-01T00:00:02Z',
    null,
    '2026-01-01T00:00:03Z',
  );

  const session = database.listSessions('workspace-1').find(
    (candidate) => candidate.id === 'session-1',
  );
  const transcript = database.listMessages('session-1');
  const highWaterCursor = database.getSessionMessageCursor('session-1');
  const incremental = database.listMessages('session-1', {
    after: visibleCursor,
  });

  assert.equal(session.queuedCount, 1);
  assert.ok(highWaterCursor > visibleCursor);
  assert.equal(
    transcript.messages.some((message) => message.text === 'Cancelled message'),
    false,
  );
  assert.equal(transcript.cursor, visibleCursor);
  assert.deepEqual(incremental.messages, []);
  assert.equal(incremental.cursor, highWaterCursor);
});

test('large-database queries keep the indexed sent and cancellation predicates', async () => {
  const source = await fs.readFile(
    new URL('../src/conductor-db.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /queued\.sent_at IS NULL[\s\S]*\+queued\.cancelled_at IS NULL/);
  assert.match(source, /WHERE session_id = \? AND cancelled_at IS NULL/);
  assert.match(
    source,
    /WHERE session_id = \? AND cancelled_at IS NULL AND rowid > \?/,
  );
  assert.match(
    source,
    /SELECT MAX\(rowid\) AS row_id[\s\S]*INDEXED BY idx_session_messages_cancelled_at[\s\S]*cancelled_at IS NULL[\s\S]*UNION ALL[\s\S]*cancelled_at IS NOT NULL/,
  );
  assert.match(
    source,
    /visibleUserMessage: this\.\#db\.prepare\(`[\s\S]*?WHERE rowid = \?[\s\S]*?AND session_id = \?/,
  );
});

test('nested deep-research rows are filtered before the visible limit', async (context) => {
  const { database, insert } = await createConfirmationFixture(context);
  insert.run(
    'root-progress',
    'session-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Root progress' }] },
    }),
    '2026-01-01T00:00:01Z',
    null,
    null,
  );
  for (let index = 0; index < 600; index += 1) {
    insert.run(
      `nested-replay-${index}`,
      'session-1',
      'assistant',
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'spawn-deep-research',
        message: {
          content: [{ type: 'text', text: `Nested replay ${index}` }],
        },
      }),
      '2026-01-01T00:00:02Z',
      null,
      null,
    );
  }
  for (let index = 0; index < 600; index += 1) {
    insert.run(
      `root-status-${index}`,
      'session-1',
      'assistant',
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
      }),
      '2026-01-01T00:00:02Z',
      null,
      null,
    );
  }
  insert.run(
    'root-final',
    'session-1',
    'assistant',
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Root final' }] },
    }),
    '2026-01-01T00:00:03Z',
    null,
    null,
  );
  insert.run(
    'root-result',
    'session-1',
    'assistant',
    JSON.stringify({ type: 'result', is_error: false }),
    '2026-01-01T00:00:04Z',
    null,
    null,
  );

  const result = database.listMessages('session-1', { limit: 3 });
  assert.deepEqual(
    result.messages.map((message) => message.kind),
    ['assistant', 'assistant', 'turn-result'],
  );
  assert.deepEqual(
    result.messages
      .filter((message) => message.kind === 'assistant')
      .map((message) => message.text),
    ['Root progress', 'Root final'],
  );
});

test('send confirmation ignores old, inexact, foreign, non-user, and cancelled rows', async (context) => {
  const { database, insert } = await createConfirmationFixture(context);
  const exactContent = 'Exact\nmessage with trailing space ';
  insert.run(
    'old-exact',
    'session-1',
    'user',
    exactContent,
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    null,
  );

  const cursor = database.getSessionMessageCursor('session-1');
  assert.ok(cursor > 0);
  assert.equal(database.getSessionMessageCursor('session-2'), 0);
  assert.equal(
    database.findExactUserMessageAfter('session-1', cursor, exactContent),
    null,
  );

  insert.run(
    'assistant-exact',
    'session-1',
    'assistant',
    exactContent,
    '2026-01-01T00:00:01Z',
    null,
    null,
  );
  insert.run(
    'foreign-exact',
    'session-2',
    'user',
    exactContent,
    '2026-01-01T00:00:02Z',
    null,
    null,
  );
  insert.run(
    'case-difference',
    'session-1',
    'user',
    'exact\nmessage with trailing space ',
    '2026-01-01T00:00:03Z',
    null,
    null,
  );
  insert.run(
    'whitespace-difference',
    'session-1',
    'user',
    'Exact\nmessage with trailing space',
    '2026-01-01T00:00:04Z',
    null,
    null,
  );
  insert.run(
    'newline-difference',
    'session-1',
    'user',
    'Exact\r\nmessage with trailing space ',
    '2026-01-01T00:00:05Z',
    null,
    null,
  );
  insert.run(
    'cancelled-exact',
    'session-1',
    'user',
    exactContent,
    '2026-01-01T00:00:06Z',
    null,
    '2026-01-01T00:00:07Z',
  );

  assert.equal(
    database.findExactUserMessageAfter('session-1', cursor, exactContent),
    null,
  );
});

test('send confirmation sees a newly inserted exact queued user row on the live connection', async (context) => {
  const { database, insert } = await createConfirmationFixture(context);
  const exactContent = 'Queued from Pocket';
  const cursor = database.getSessionMessageCursor('session-1');

  insert.run(
    'queued-exact',
    'session-1',
    'user',
    exactContent,
    '2026-01-01T00:00:01Z',
    null,
    null,
  );

  const match = database.findExactUserMessageAfter(
    'session-1',
    cursor,
    exactContent,
  );
  assert.equal(match.id, 'queued-exact');
  assert.ok(match.rowId > cursor);
  assert.equal(match.sentAt, null);
  assert.deepEqual(
    database
      .listUserMessagesAfter('session-1', cursor)
      .map((message) => message.id),
    ['queued-exact'],
  );
});
