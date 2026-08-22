import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  classifyAgentError,
  ConductorDatabase,
} from '../src/conductor-db.mjs';

test('agent errors emit only allowlisted codes and behavior without provider details', () => {
  const error = classifyAgentError({
    type: 'error',
    content: 'Rate limit reached PRIVATE_PROVIDER_DETAIL',
    errorInfo: 'PRIVATE_ACCOUNT_IDENTIFIER',
    additionalDetails: 'PRIVATE_RECONNECT_URL',
    willRetry: false,
  });

  assert.deepEqual(error, {
    code: 'usage_limit',
    severity: 'error',
    retrying: false,
  });
  const serialized = JSON.stringify(error);
  assert.equal(serialized.includes('PRIVATE_PROVIDER_DETAIL'), false);
  assert.equal(serialized.includes('PRIVATE_ACCOUNT_IDENTIFIER'), false);
  assert.equal(serialized.includes('PRIVATE_RECONNECT_URL'), false);
  assert.deepEqual(
    classifyAgentError({
      type: 'system',
      subtype: 'permission_denied',
      content: 'PRIVATE_PERMISSION_DETAIL',
    }),
    {
      code: 'permission_required',
      severity: 'error',
      retrying: false,
    },
  );
  const cyber = classifyAgentError({
    type: 'result',
    is_error: true,
    result:
      'Error: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber PRIVATE_POLICY_TRACE',
  });
  assert.deepEqual(cyber, {
    code: 'cybersecurity_policy',
    severity: 'error',
    retrying: false,
  });
  assert.equal(JSON.stringify(cyber).includes('PRIVATE_POLICY_TRACE'), false);
});

test('database adapter emits normalized failures and never raw diagnostics', async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-agent-errors-'),
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
      (id, repository_id, workspace_name, state, unread, updated_at)
      VALUES ('workspace-1', 'repo-1', 'Pocket errors', 'ready', 0, '2026-01-01');
    INSERT INTO sessions
      (
        id,
        workspace_id,
        title,
        agent_type,
        model,
        status,
        unread_count,
        created_at,
        updated_at,
        is_hidden
      )
      VALUES
      (
        'session-1',
        'workspace-1',
        'Error chat',
        'codex',
        'gpt-test',
        'error',
        0,
        '2026-01-01',
        '2026-01-01',
        0
      );
  `);
  const insert = writable.prepare(`
    INSERT INTO session_messages
      (id, session_id, role, content, created_at, model, turn_id)
    VALUES (?, 'session-1', 'assistant', ?, ?, 'gpt-test', 'turn-1')
  `);
  insert.run(
    'error-1',
    JSON.stringify({
      type: 'error',
      content: 'Unauthorized PRIVATE_AUTH_RESPONSE',
      errorInfo: 'PRIVATE_ACCOUNT_IDENTIFIER',
      willRetry: false,
    }),
    '2026-01-01T00:00:01Z',
  );
  insert.run(
    'error-2',
    JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Model unavailable PRIVATE_MODEL_IDENTIFIER',
      subtype: 'error',
    }),
    '2026-01-01T00:00:02Z',
  );
  insert.run(
    'error-3',
    JSON.stringify({
      type: 'system',
      subtype: 'permission_denied',
      content: 'PRIVATE_PERMISSION_DETAIL',
    }),
    '2026-01-01T00:00:03Z',
  );
  insert.run(
    'error-4',
    JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      additionalDetails: 'PRIVATE_RETRY_DETAIL',
    }),
    '2026-01-01T00:00:04Z',
  );
  insert.run(
    'error-5',
    JSON.stringify({
      type: 'stream_error',
      content: 'Service unavailable PRIVATE_STREAM_DETAIL',
    }),
    '2026-01-01T00:00:05Z',
  );
  insert.run(
    'error-6',
    JSON.stringify({
      type: 'system',
      status: 'permission_denied',
      parent_tool_use_id: 'spawn-private',
      content: 'PRIVATE_NESTED_PERMISSION_DETAIL',
    }),
    '2026-01-01T00:00:06Z',
  );
  insert.run(
    'error-7',
    JSON.stringify({
      type: 'result',
      is_error: true,
      result:
        'This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber at https://chatgpt.com/cyber PRIVATE_CYBER_TRACE',
    }),
    '2026-01-01T00:00:07Z',
  );
  const database = new ConductorDatabase(dbPath);
  context.after(async () => {
    database.close();
    writable.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const result = database.listMessages('session-1');
  assert.deepEqual(
    result.messages
      .filter((message) => message.kind === 'agent-error')
      .map((message) => message.code),
    [
      'provider_auth_required',
      'model_unavailable',
      'permission_required',
      'provider_reconnecting',
      'provider_unavailable',
      'permission_required',
      'cybersecurity_policy',
    ],
  );
  assert.equal(
    result.messages.some(
      (message) =>
        message.kind === 'turn-result' && message.state === 'failed',
    ),
    true,
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('PRIVATE_AUTH_RESPONSE'), false);
  assert.equal(serialized.includes('PRIVATE_ACCOUNT_IDENTIFIER'), false);
  assert.equal(serialized.includes('PRIVATE_MODEL_IDENTIFIER'), false);
  assert.equal(serialized.includes('PRIVATE_PERMISSION_DETAIL'), false);
  assert.equal(serialized.includes('PRIVATE_RETRY_DETAIL'), false);
  assert.equal(serialized.includes('PRIVATE_STREAM_DETAIL'), false);
  assert.equal(serialized.includes('PRIVATE_NESTED_PERMISSION_DETAIL'), false);
  assert.equal(serialized.includes('PRIVATE_CYBER_TRACE'), false);
  assert.equal(serialized.includes('chatgpt.com/cyber'), false);
});

test('the browser renders only allowlisted error copy and a real cyber recovery link', async () => {
  const [application, stylesheet] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  assert.match(application, /Blocked: cybersecurity policy/);
  assert.match(application, /https:\/\/chatgpt\.com\/cyber/);
  assert.match(
    application,
    /target: '_blank'[\s\S]*rel: 'noopener noreferrer'/,
  );
  assert.match(
    application,
    /className: 'message agent-error',[\s\S]*role: 'alert'/,
  );
  assert.doesNotMatch(application, /text: message\.(?:title|guidance)/);
  assert.match(stylesheet, /\.agent-error-copy a[\s\S]*text-decoration: underline/);
  assert.match(stylesheet, /\.agent-error-copy a:focus-visible/);
});

test('a usage limit is named as one even while the client keeps retrying', () => {
  // Claude Code retries a usage limit, so the event carries willRetry:true or
  // arrives as an api_retry. Both used to short-circuit to provider_reconnecting
  // BEFORE the text was ever read, so the operator was told the agent was
  // reconnecting when it had simply run out of session usage. A limit resets on
  // a clock, not when a connection comes back, so nothing they do to the
  // network helps and the wrong message sends them looking in the wrong place.
  assert.deepEqual(
    classifyAgentError({
      type: 'error',
      content: 'Usage limit reached for this session',
      willRetry: true,
    }),
    { code: 'usage_limit', severity: 'error', retrying: false },
  );
  assert.deepEqual(
    classifyAgentError({
      type: 'system',
      subtype: 'api_retry',
      content: 'rate limit reached, retrying',
    }),
    { code: 'usage_limit', severity: 'error', retrying: false },
  );

  // A genuine connection retry, with nothing in the text naming a definite
  // cause, must still read as reconnecting.
  assert.deepEqual(
    classifyAgentError({
      type: 'system',
      subtype: 'api_retry',
      content: 'connection reset, retrying',
    }),
    { code: 'provider_reconnecting', severity: 'warning', retrying: true },
  );
  assert.deepEqual(
    classifyAgentError({
      type: 'error',
      content: 'socket hang up',
      willRetry: true,
    }),
    { code: 'provider_reconnecting', severity: 'warning', retrying: true },
  );

  // An explicit permission signal outranks text inference, so a permission
  // prompt mentioning authentication is not re-read as an auth failure.
  assert.deepEqual(
    classifyAgentError({
      type: 'system',
      subtype: 'permission_denied',
      content: 'needs authentication to approve this tool',
    }),
    { code: 'permission_required', severity: 'error', retrying: false },
  );
})

test('a superseded agent error stops giving advice, and seat usage is whitelisted', async () => {
  const js = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  // An agent error records a moment, not a running state. Once the agent has
  // produced anything newer, "Out of usage for this session. This resets on a
  // timer..." is no longer true, and leaving that advice on screen sent the
  // operator chasing a limit that had already reset.
  assert.match(js, /let newestRootEventRowId = 0;/);
  assert.match(js, /superseded \? null : guidance/);
  assert.match(js, /card\.classList\.add\('is-past'\)/);

  // The raw producer payload carries fingerprints, refresh state and full
  // history. None of it should cross the wire just because it was in the
  // response, so the shape is a fixed whitelist.
  const server = await fs.readFile(
    new URL('../src/server.mjs', import.meta.url),
    'utf8',
  );
  const readerStart = server.indexOf('export async function readSeatUsage');
  assert.ok(readerStart > 0, 'readSeatUsage must exist');
  const readerBody = server.slice(readerStart, server.indexOf('\n}\n', readerStart));
  for (const leaked of ['fingerprint', 'refreshFailed', 'utilizationHistory', 'weeklyHistory']) {
    assert.doesNotMatch(
      readerBody,
      new RegExp(leaked),
      `${leaked} must not be forwarded to the phone`,
    );
  }
  // Both windows are reported separately: a seat can sit at 0% on the five hour
  // window while the weekly one is spent, which is the state that reads as
  // unexplained. Observed live 2026-08-20: 5h 0%, weekly 100%, blocked.
  assert.match(readerBody, /fiveHourPercent/);
  assert.match(readerBody, /weeklyPercent/);
  assert.match(readerBody, /weeklyBlocked/);
  // A convenience readout must never take down the screen opened to diagnose
  // something else.
  assert.match(readerBody, /available: false, reason: 'producer_unreachable'/);
})

test('ordinary messages are never turned into error cards by their wording', () => {
  // The regression that shipped 2026-08-20: the text classifier was moved ahead
  // of the guard that decides whether an event failed at all, so any message
  // mentioning this vocabulary became an error card. Discussing usage limits
  // produced a banner claiming the session was out of usage, and mentioning
  // signing in produced a sign-in demand. Both were reported from the phone
  // within the hour. What kind of event this is must be decided BEFORE its
  // words are read.
  const innocuous = [
    { type: 'assistant', content: 'You are nowhere near the usage limit right now.' },
    { type: 'assistant', content: 'Check the rate limit and quota on that account.' },
    { type: 'assistant', content: 'You may need to sign in again, or check credentials.' },
    { type: 'assistant', content: 'That model is unavailable on the free plan.' },
    { type: 'assistant', content: 'This is a policy question about billing credits.' },
    { type: 'result', subtype: 'success', is_error: false, result: 'usage limit reached, per the docs' },
    { type: 'user', content: 'am I out of usage or is it a rate limit' },
  ];
  for (const event of innocuous) {
    assert.equal(
      classifyAgentError(event),
      null,
      `a ${event.type} event must not be classified as an error: ${String(event.content || event.result).slice(0, 48)}`,
    );
  }

  // Real failures carrying the same words must still classify, or the guard
  // above would have been fixed by breaking the feature.
  assert.deepEqual(
    classifyAgentError({ type: 'error', content: 'Usage limit reached', willRetry: true }),
    { code: 'usage_limit', severity: 'error', retrying: false },
  );
  assert.deepEqual(
    classifyAgentError({ type: 'result', is_error: true, result: 'quota exhausted' }),
    { code: 'usage_limit', severity: 'error', retrying: false },
  );
})
