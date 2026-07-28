import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appUpdateReloadIsSafe,
  createAppUpdateCoordinator,
  createServiceWorkerRegistrationGetter,
} from '../public/app-update.js';

function fakeServiceWorker(controller = null) {
  const listeners = new Map();
  return {
    controller,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type) {
      for (const listener of listeners.get(type) || []) listener();
    },
  };
}

function coordinatorOptions(serviceWorker, overrides = {}) {
  return {
    serviceWorker,
    getRegistration: async () => ({ update: async () => {} }),
    canReload: () => true,
    reload: () => {},
    ...overrides,
  };
}

test('idle gates may update while sensitive and unsent states remain blocked', () => {
  assert.equal(appUpdateReloadIsSafe(), true);
  assert.equal(appUpdateReloadIsSafe({ originRetired: true }), false);
  assert.equal(appUpdateReloadIsSafe({ sensitiveOperations: 1 }), false);
  assert.equal(appUpdateReloadIsSafe({ pairing: true }), false);
  assert.equal(appUpdateReloadIsSafe({ overlayOpen: true }), false);
  assert.equal(appUpdateReloadIsSafe({ composerValue: 'unsent draft' }), false);
  assert.equal(
    appUpdateReloadIsSafe({ deliveries: [{ delivery: 'delivering' }] }),
    false,
  );
  assert.equal(
    appUpdateReloadIsSafe({ deliveries: [{ delivery: 'confirming' }] }),
    false,
  );
  assert.equal(
    appUpdateReloadIsSafe({ deliveries: [{ delivery: 'failed' }] }),
    true,
  );
});

test('the first service worker claim is ignored and a later replacement reloads once', () => {
  const serviceWorker = fakeServiceWorker();
  let reloads = 0;
  const coordinator = createAppUpdateCoordinator(
    coordinatorOptions(serviceWorker, {
      reload: () => {
        reloads += 1;
      },
    }),
  );
  coordinator.start();

  serviceWorker.controller = { id: 'first-controller' };
  serviceWorker.emit('controllerchange');
  assert.equal(reloads, 0);

  serviceWorker.controller = { id: 'updated-controller' };
  serviceWorker.emit('controllerchange');
  serviceWorker.emit('controllerchange');
  coordinator.stateChanged();
  assert.equal(reloads, 1);
});

test('an update waits for unsafe app state to clear', () => {
  const serviceWorker = fakeServiceWorker({ id: 'old-controller' });
  let safe = false;
  let reloads = 0;
  const coordinator = createAppUpdateCoordinator(
    coordinatorOptions(serviceWorker, {
      canReload: () => safe,
      reload: () => {
        reloads += 1;
      },
    }),
  );
  coordinator.start();

  serviceWorker.controller = { id: 'new-controller' };
  serviceWorker.emit('controllerchange');
  assert.equal(reloads, 0);

  safe = true;
  coordinator.stateChanged();
  assert.equal(reloads, 1);
});

test('an unsafe update does not create a background retry loop', async () => {
  const serviceWorker = fakeServiceWorker({ id: 'old-controller' });
  let safetyChecks = 0;
  const coordinator = createAppUpdateCoordinator(
    coordinatorOptions(serviceWorker, {
      canReload: () => {
        safetyChecks += 1;
        return false;
      },
    }),
  );
  coordinator.start();

  serviceWorker.controller = { id: 'new-controller' };
  serviceWorker.emit('controllerchange');
  assert.equal(safetyChecks, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(safetyChecks, 1);
});

test('a hidden update reloads on the next safe foreground', async () => {
  const serviceWorker = fakeServiceWorker({ id: 'old-controller' });
  let hidden = true;
  let reloads = 0;
  let updateChecks = 0;
  const coordinator = createAppUpdateCoordinator(
    coordinatorOptions(serviceWorker, {
      getRegistration: async () => ({
        update: async () => {
          updateChecks += 1;
        },
      }),
      isHidden: () => hidden,
      reload: () => {
        reloads += 1;
      },
    }),
  );
  coordinator.start();

  serviceWorker.controller = { id: 'new-controller' };
  serviceWorker.emit('controllerchange');
  assert.equal(reloads, 0);

  hidden = false;
  assert.equal(coordinator.foreground(), true);
  await Promise.resolve();
  assert.equal(reloads, 1);
  assert.equal(updateChecks, 1);
});

test('a missed controllerchange is recovered by an explicit update check', async () => {
  const serviceWorker = fakeServiceWorker({ id: 'old-controller' });
  let reloads = 0;
  const coordinator = createAppUpdateCoordinator(
    coordinatorOptions(serviceWorker, {
      reload: () => {
        reloads += 1;
      },
    }),
  );
  coordinator.start();

  serviceWorker.controller = { id: 'new-controller' };
  assert.equal(await coordinator.checkForUpdate({ force: true }), true);
  assert.equal(reloads, 1);
});

test('concurrent update checks coalesce and a failed check remains retryable', async () => {
  const serviceWorker = fakeServiceWorker({ id: 'controller' });
  let attempts = 0;
  let release;
  const coordinator = createAppUpdateCoordinator(
    coordinatorOptions(serviceWorker, {
      getRegistration: async () => ({
        update: async () => {
          attempts += 1;
          if (attempts === 1) {
            await new Promise((resolve) => {
              release = resolve;
            });
            throw new Error('offline');
          }
        },
      }),
      now: () => 1_000,
    }),
  );

  const first = coordinator.checkForUpdate({ force: true });
  const concurrent = coordinator.checkForUpdate({ force: true });
  await Promise.resolve();
  release();
  assert.deepEqual(await Promise.all([first, concurrent]), [false, false]);
  assert.equal(attempts, 1);

  assert.equal(await coordinator.checkForUpdate(), true);
  assert.equal(attempts, 2);
});

test('a failed service worker registration is cleared and retried', async () => {
  const expected = { update: async () => {} };
  let attempts = 0;
  const getRegistration = createServiceWorkerRegistrationGetter({
    serviceWorker: {
      async register(scriptUrl, options) {
        attempts += 1;
        assert.equal(scriptUrl, '/service-worker.js');
        assert.deepEqual(options, { updateViaCache: 'none' });
        if (attempts === 1) throw new Error('relay_unreachable');
        return expected;
      },
    },
  });

  await assert.rejects(getRegistration(), /relay_unreachable/);
  const recovered = getRegistration();
  assert.strictEqual(getRegistration(), recovered);
  assert.strictEqual(await recovered, expected);
  assert.equal(attempts, 2);
});

test('stopping the coordinator prevents a later controller replacement reload', () => {
  const serviceWorker = fakeServiceWorker({ id: 'old-controller' });
  let reloads = 0;
  const coordinator = createAppUpdateCoordinator(
    coordinatorOptions(serviceWorker, {
      reload: () => {
        reloads += 1;
      },
    }),
  );
  coordinator.start();
  coordinator.stop();

  serviceWorker.controller = { id: 'new-controller' };
  serviceWorker.emit('controllerchange');
  coordinator.stateChanged();
  assert.equal(reloads, 0);
});
