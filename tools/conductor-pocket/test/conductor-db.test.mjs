import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConductorDatabase } from '../src/conductor-db.mjs';

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
      placeholder_branch_name TEXT,
      branch TEXT,
      directory_name TEXT,
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
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('must-not-leak'), false);
  assert.equal(serialized.includes('highly sensitive output'), false);
});
