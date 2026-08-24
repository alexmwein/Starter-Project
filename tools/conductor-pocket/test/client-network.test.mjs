import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
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
