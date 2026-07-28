import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchJson } from '../public/http.js';
import { createLiveRefreshCoordinator } from '../public/live-refresh.js';

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
