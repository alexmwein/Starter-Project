import assert from 'node:assert/strict';
import test from 'node:test';

let usageState = null;
try {
  usageState = await import('../public/usage-state.js');
} catch {
  usageState = null;
}

test('usage requests share one in flight promise and refresh after the ttl', async () => {
  assert.ok(usageState, 'the usage state module must exist');
  const { createUsageReader } = usageState;
  let now = 1_000;
  let calls = 0;
  let resolveRequest;
  const reader = createUsageReader({
    now: () => now,
    ttlMs: 500,
    load: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    },
  });

  const initial = reader.read();
  const forced = reader.read({ force: true });
  assert.equal(initial, forced, 'forced refresh must join the active request');
  assert.equal(calls, 1);
  resolveRequest({ available: true, fetchedAt: now, providers: [] });
  await initial;

  assert.equal(await reader.read(), reader.peek());
  assert.equal(calls, 1, 'fresh cache must be reused');

  now += 501;
  const staleRefresh = reader.read();
  assert.equal(calls, 2, 'an open app must refresh stale usage');
  resolveRequest({ available: true, fetchedAt: now, providers: [] });
  await staleRefresh;
});

test('the glance selects the active GPT account and reports freshness', async () => {
  assert.ok(usageState, 'the usage state module must exist');
  const { activeGptUsage } = usageState;
  const selected = activeGptUsage({
    available: true,
    providers: [
      {
        id: 'claude',
        accounts: [{ name: 'wrong-provider', active: true, weeklyPercent: 99 }],
      },
      {
        id: 'gpt',
        accounts: [
          { name: 'seat3', active: false, weeklyPercent: 4 },
          {
            name: 'seat4',
            active: true,
            weeklyPercent: 76,
            stale: false,
            fetchedAt: 1_000,
          },
        ],
      },
    ],
  });

  assert.deepEqual(selected, {
    name: 'seat4',
    active: true,
    weeklyPercent: 76,
    stale: false,
    fetchedAt: 1_000,
  });
  assert.equal(activeGptUsage({ available: false }), null);
});

test('a refresh failure keeps the last account snapshot and marks it stale', async () => {
  assert.ok(usageState, 'the usage state module must exist');
  const { activeGptUsage, createUsageReader } = usageState;
  let now = 10;
  let fail = false;
  const snapshot = {
    available: true,
    providers: [
      {
        id: 'gpt',
        available: true,
        accounts: [
          { name: 'seat4', active: true, weeklyPercent: 76, stale: false },
        ],
      },
    ],
  };
  const reader = createUsageReader({
    now: () => now,
    ttlMs: 50,
    load: async () => {
      if (fail) throw new Error('temporary');
      return snapshot;
    },
  });

  await reader.read();
  now = 100;
  fail = true;
  const retained = await reader.read();

  assert.equal(retained.available, true);
  assert.equal(retained.refreshFailed, true);
  assert.equal(activeGptUsage(retained).weeklyPercent, 76);
  assert.equal(activeGptUsage(retained).stale, true);
});

test('usage account status distinguishes sign-in from an unknown percentage', () => {
  assert.ok(usageState, 'the usage state module must exist');
  const { usageAccountStatus } = usageState;
  assert.equal(typeof usageAccountStatus, 'function');

  assert.deepEqual(
    usageAccountStatus({ needsLogin: true, weeklyPercent: null, stale: true }),
    { blocked: false, text: 'Needs sign-in' },
  );
  assert.deepEqual(
    usageAccountStatus({ weeklyPercent: null, stale: true }),
    { blocked: false, text: 'No data yet' },
  );
  assert.deepEqual(
    usageAccountStatus({ weeklyPercent: 23, stale: true }),
    { blocked: false, text: 'week 23% · cached' },
  );
  assert.deepEqual(
    usageAccountStatus({ weeklyPercent: 100, weeklyBlocked: true }),
    { blocked: true, text: 'Weekly spent · week 100%' },
  );
});
