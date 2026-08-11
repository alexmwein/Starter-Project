import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBootstrapCoordinator,
} from '../public/bootstrap-recovery.js';
import { fetchJson } from '../public/http.js';

test('a stalled bootstrap reaches failure within its bound', async () => {
  const states = [];
  const coordinator = createBootstrapCoordinator({
    timeoutMs: 15,
    onStart: () => states.push('starting'),
    load: ({ signal, timeoutMs }) =>
      fetchJson('/api/auth/bootstrap', {
        signal,
        timeoutMs,
        fetchImpl: (_pathname, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true },
            );
          }),
      }),
    onSuccess: () => states.push('success'),
    onFailure: (error) => states.push(error.message),
  });

  await coordinator.run();
  assert.deepEqual(states, ['starting', 'request_timeout']);
});

test('retry supersedes an older bootstrap and can recover successfully', async () => {
  const starts = [];
  const successes = [];
  const failures = [];
  let firstSignal;
  let calls = 0;
  const coordinator = createBootstrapCoordinator({
    timeoutMs: 100,
    onStart: () => starts.push('starting'),
    load: ({ signal }) => {
      calls += 1;
      if (calls === 1) {
        firstSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      }
      return Promise.resolve({ unlocked: false });
    },
    onSuccess: (auth) => successes.push(auth),
    onFailure: (error) => failures.push(error),
  });

  const first = coordinator.run();
  await Promise.resolve();
  const retry = coordinator.run();
  await Promise.all([first, retry]);

  assert.equal(firstSignal.aborted, true);
  assert.equal(starts.length, 2);
  assert.deepEqual(successes, [{ unlocked: false }]);
  assert.deepEqual(failures, []);
});
