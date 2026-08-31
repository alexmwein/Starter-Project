import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { fetchJson } from '../public/http.js';
import {
  applyConnectionAvailability,
  createLiveRefreshCoordinator,
  createSessionMessageRequestCoordinator,
} from '../public/live-refresh.js';

test('the request timeout remains active while a response body stalls', async () => {
  let receivedSignal;
  const fetchImpl = async (_pathname, options) => {
    receivedSignal = options.signal;
    return {
      ok: true,
      json() {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      },
    };
  };

  await assert.rejects(
    fetchJson('/api/auth/touch', {
      method: 'POST',
      timeoutMs: 10,
      fetchImpl,
    }),
    (error) =>
      error?.name === 'TimeoutError' &&
      error?.message === 'request_timeout',
  );
  assert.equal(receivedSignal.aborted, true);
});

test('New Chat has a bounded request and always releases its busy control', async () => {
  const source = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /const TAB_ACTION_REQUEST_MS = \d[\d_]*;/);
  const tabStart = source.indexOf('async function runTabAction(');
  const tabEnd = source.indexOf('function currentWorkspaceName', tabStart);
  assert.match(
    source.slice(tabStart, tabEnd),
    /timeoutMs: TAB_ACTION_REQUEST_MS/,
  );

  const creationStart = source.indexOf('async function createChat(');
  const creationEnd = source.indexOf('async function runCreateChat', creationStart);
  const creationSource = source.slice(creationStart, creationEnd);
  const announcements = [];
  const timeout = new Error('request_timeout');
  timeout.name = 'TimeoutError';
  const context = vm.createContext({
    announce: (message) => announcements.push(message),
    runCreateChat: async () => {
      throw timeout;
    },
  });
  vm.runInContext(
    `let chatCreationInFlight = false; ${creationSource}; globalThis.createChat = createChat;`,
    context,
  );
  const attributes = new Map();
  const control = {
    disabled: false,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };

  const result = await context.createChat({ control });
  assert.equal(result, null);
  assert.equal(control.disabled, false);
  assert.equal(attributes.has('aria-busy'), false);
  assert.match(announcements.at(-1), /stopped waiting|could not create/i);
});

test('New Chat retries retain one idempotency key until the Mac result is known', async () => {
  const source = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const tabStart = source.indexOf('async function runTabAction(');
  const createEnd = source.indexOf('const TAB_ACTION_MESSAGES', tabStart);
  const body = source.slice(tabStart, createEnd);

  assert.match(body, /CHAT_CREATION_ATTEMPTS_KEY/);
  assert.match(body, /CHAT_CREATION_ATTEMPT_MAX/);
  assert.match(body, /CHAT_CREATION_SETTLED_GRACE_MS/);
  assert.match(body, /navigator\?\.locks\?\.request|navigator\.locks\.request/);
  assert.match(body, /withChatCreationAttemptLock/);
  assert.match(body, /'Idempotency-Key'/);
  assert.match(body, /loadChatCreationAttempt/);
  assert.match(body, /saveChatCreationAttempt/);
  assert.match(body, /clearChatCreationAttempt/);
  assert.match(body, /settleChatCreationAttempt/);
  assert.match(body, /attempt\?\.anchorSessionId \|\| state\.route\.sessionId/);
  assert.match(
    body,
    /saveChatCreationAttempt\(workspaceId, anchorSessionId(?:, now)?\)/,
  );
  assert.match(body, /requireDefinitive: true/);
  assert.match(body, /TabActionIndeterminateError/);
  assert.match(body, /payload\?\.error\?\.code/);
  assert.match(body, /TabActionRouteUnavailableError/);
  assert.match(body, /rebindChatCreationAttempt/);
});

test('New Chat keeps its key when a dead anchor is replaced in the same workspace', async () => {
  const source = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('async function runCreateChat(');
  const end = source.indexOf('\n}\n', start) + 3;
  const runCreateChatSource = source.slice(start, end);
  const originalAttempt = {
    key: 'stable-new-chat-key',
    workspaceId: 'workspace-1',
    anchorSessionId: 'session-a',
    createdAt: 100,
  };
  const actionCalls = [];
  let reboundAttempt = null;
  let settledAttempt = null;
  const context = vm.createContext({
    state: {
      route: { workspaceId: 'workspace-1', sessionId: 'session-a' },
    },
    loadChatCreationAttempt: () => originalAttempt,
    allocateChatCreationAttempt: async () => originalAttempt,
    loadSessions: async () => [{ id: 'session-b' }],
    sessionsFor: () => [{ id: 'session-b' }],
    runTabAction: async (_action, options) => {
      actionCalls.push(options);
      if (actionCalls.length === 1) {
        const error = new Error('session_not_found');
        error.name = 'TabActionRouteUnavailableError';
        throw error;
      }
      return { ok: true, code: 'tab_created' };
    },
    rebindChatCreationAttempt: async (attempt, anchorSessionId) => {
      reboundAttempt = { ...attempt, anchorSessionId };
      return reboundAttempt;
    },
    clearChatCreationAttempt: async () => {
      throw new Error('a successful retry must not clear its receipt');
    },
    settleChatCreationAttempt: async (attempt) => {
      settledAttempt = attempt;
      return attempt;
    },
    currentWorkspaceName: () => 'Workspace',
    loadRecentSessions: async () => {},
    openSession: async () => {},
    announce: () => {},
  });
  vm.runInContext(
    `${runCreateChatSource}; globalThis.runCreateChat = runCreateChat;`,
    context,
  );

  await context.runCreateChat();

  assert.deepEqual(
    actionCalls.map(({ sessionId, idempotencyKey }) => ({
      sessionId,
      idempotencyKey,
    })),
    [
      { sessionId: 'session-a', idempotencyKey: 'stable-new-chat-key' },
      { sessionId: 'session-b', idempotencyKey: 'stable-new-chat-key' },
    ],
  );
  assert.equal(reboundAttempt.anchorSessionId, 'session-b');
  assert.equal(settledAttempt.key, 'stable-new-chat-key');
});

test('a stopped refresh generation cannot block or clobber the next one', async () => {
  let firstResolve;
  let firstSignal;
  let calls = 0;
  const coordinator = createLiveRefreshCoordinator({
    delayMs: 0,
    run({ signal }) {
      calls += 1;
      if (calls === 1) {
        firstSignal = signal;
        return new Promise((resolve) => {
          firstResolve = resolve;
        });
      }
      return Promise.resolve();
    },
  });

  const first = coordinator.flush();
  await Promise.resolve();
  assert.equal(calls, 1);

  coordinator.stop();
  assert.equal(firstSignal.aborted, true);
  await coordinator.flush();
  assert.equal(calls, 2);

  firstResolve();
  await first;
  await coordinator.flush();
  assert.equal(calls, 3);
  coordinator.stop();
});

test('live refresh changes collapse into one trailing pass', async () => {
  let releaseFirst;
  let calls = 0;
  const coordinator = createLiveRefreshCoordinator({
    delayMs: 0,
    run() {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve();
    },
  });

  coordinator.schedule();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  coordinator.schedule();
  coordinator.schedule();
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  coordinator.stop();
});

test('flush consumes a scheduled refresh instead of running it twice', async () => {
  let calls = 0;
  const coordinator = createLiveRefreshCoordinator({
    delayMs: 15,
    run() {
      calls += 1;
    },
  });

  coordinator.schedule();
  await coordinator.flush();
  assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1);
  coordinator.stop();
});

test('reachable connection recovery revives data and delivery state', () => {
  const state = {
    connection: 'offline',
    lastHeartbeat: 10,
  };
  const calls = [];
  applyConnectionAvailability({
    state,
    status: 'live',
    now: 900,
    render: () => calls.push('render'),
    restartEvents: () => calls.push('events'),
    refresh: () => calls.push('refresh'),
    recheckDeliveries: () => calls.push('recheck'),
    recoverDeliveries: () => calls.push('recover'),
  });

  assert.equal(state.connection, 'live');
  assert.equal(state.lastHeartbeat, 900);
  assert.deepEqual(calls, [
    'render',
    'events',
    'refresh',
    'recheck',
    'recover',
  ]);
});

test('offline connection state updates immediately without recovery work', () => {
  const state = {
    connection: 'live',
    lastHeartbeat: 900,
  };
  const calls = [];
  applyConnectionAvailability({
    state,
    status: 'offline',
    render: () => calls.push('render'),
    restartEvents: () => calls.push('events'),
    refresh: () => calls.push('refresh'),
    recheckDeliveries: () => calls.push('recheck'),
    recoverDeliveries: () => calls.push('recover'),
  });

  assert.equal(state.connection, 'offline');
  assert.deepEqual(calls, ['render']);
});

test('connection controls revive the current app without replacing the sheet', async () => {
  const source = await fs.readFile(
    new URL('../public/app.js', import.meta.url),
    'utf8',
  );
  const connectionSheet = source.match(
    /async function runConnectionCheck[\s\S]*?(?=\nasync function openSecurity)/,
  )?.[0];
  assert.ok(connectionSheet);
  assert.match(connectionSheet, /applyAppConnectionAvailability\('live'/);
  assert.match(connectionSheet, /await runConnectionCheck\(content\)/);
  assert.doesNotMatch(
    connectionSheet,
    /click:\s*\(\)\s*=>\s*openConnectionSheet/,
  );
  assert.equal(
    (source.match(/window\.addEventListener\('online'/g) || []).length,
    1,
  );
  assert.match(
    source,
    /window\.addEventListener\('offline', \(\) => \{[\s\S]*?applyAppConnectionAvailability\('offline'/,
  );
});

test('a full session baseline supersedes an older incremental response', async () => {
  const coordinator = createSessionMessageRequestCoordinator();
  let releaseIncremental;
  let releaseFull;
  const commits = [];
  const incremental = coordinator.run({
    sessionId: 'session-1',
    load: () =>
      new Promise((resolve) => {
        releaseIncremental = resolve;
      }),
    commit: (value) => commits.push(value),
  });
  const full = coordinator.run({
    sessionId: 'session-1',
    full: true,
    load: () =>
      new Promise((resolve) => {
        releaseFull = resolve;
      }),
    commit: (value) => commits.push(value),
  });

  releaseFull('new-full-baseline');
  await full;
  releaseIncremental('stale-incremental');
  await incremental;

  assert.deepEqual(commits, ['new-full-baseline']);
});

test('an aborted session request cannot commit or block its replacement', async () => {
  const coordinator = createSessionMessageRequestCoordinator();
  const firstController = new AbortController();
  let releaseFirst;
  const commits = [];
  const first = coordinator.run({
    sessionId: 'session-1',
    full: true,
    signal: firstController.signal,
    load: () =>
      new Promise((resolve) => {
        releaseFirst = resolve;
      }),
    commit: (value) => commits.push(value),
  });
  firstController.abort();
  const replacement = coordinator.run({
    sessionId: 'session-1',
    full: true,
    load: async () => 'replacement-baseline',
    commit: (value) => commits.push(value),
  });

  await replacement;
  releaseFirst('aborted-baseline');
  await first;

  assert.deepEqual(commits, ['replacement-baseline']);
});

test('reset invalidates old responses even when the same session is reopened', async () => {
  const coordinator = createSessionMessageRequestCoordinator();
  let releaseFirst;
  const commits = [];
  const first = coordinator.run({
    sessionId: 'session-1',
    full: true,
    load: () =>
      new Promise((resolve) => {
        releaseFirst = resolve;
      }),
    commit: (value) => commits.push(value),
  });

  coordinator.reset();
  await coordinator.run({
    sessionId: 'session-1',
    full: true,
    load: async () => 'fresh-after-reset',
    commit: (value) => commits.push(value),
  });
  releaseFirst('stale-before-reset');
  await first;

  assert.deepEqual(commits, ['fresh-after-reset']);
});
