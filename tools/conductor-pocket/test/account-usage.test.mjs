import assert from 'node:assert/strict';
import test from 'node:test';

import * as pocketServer from '../src/server.mjs';

function fileEntry(name, isFile = true) {
  return {
    name,
    isFile: () => isFile,
  };
}

test('Claude usage preserves the producer sample age and stale state', async () => {
  const now = 1_788_139_300_000;
  const fetchedAt = now - 10 * 60 * 1000;
  const staleAt = now - 5 * 60 * 1000;
  const provider = await pocketServer.readSeatUsage(
    async () => ({
      ok: true,
      async json() {
        return {
          profiles: [
            {
              name: 'upperfloorpod',
              label: 'upperfloorpod@gmail.com',
              isActive: true,
              rateLimits: {
                fetchedAt,
                staleAt,
                status: 'ok',
                fiveH: { utilization: 0.29, status: 'allowed' },
                sevenD: { utilization: 0.96, status: 'allowed' },
              },
            },
          ],
        };
      },
    }),
    { now },
  );

  assert.equal(provider.seats[0].fetchedAt, fetchedAt);
  assert.equal(provider.seats[0].stale, true);
  assert.equal(provider.fetchedAt, fetchedAt);
});

test('Claude usage expires an old cached sample when staleAt is absent', async () => {
  const now = 1_788_139_300_000;
  const fetchedAt = now - 6 * 60 * 1000;
  const provider = await pocketServer.readSeatUsage(
    async () => ({
      ok: true,
      async json() {
        return {
          profiles: [
            {
              name: 'upperfloorpod',
              isActive: true,
              rateLimits: {
                fetchedAt,
                status: 'ok',
                fiveH: { utilization: 0.29, status: 'allowed' },
                sevenD: { utilization: 0.55, status: 'allowed' },
              },
            },
          ],
        };
      },
    }),
    { now },
  );

  assert.equal(provider.seats[0].fetchedAt, fetchedAt);
  assert.equal(provider.seats[0].stale, true);
});

test('GPT usage reads only SwiftBar cache metadata and returns a fixed phone shape', async () => {
  assert.equal(typeof pocketServer.readGptUsage, 'function');
  const accountStore = '/account-store';
  const cachePath = '/swiftbar-cache.json';
  const files = new Map([
    [`${accountStore}/.active`, 'seat4'],
    [`${accountStore}/seat4.label`, 'imalexgunnar@gmail.com'],
    [
      cachePath,
      JSON.stringify({
        samples: {
          seat3: {
            used_percent: 108,
            resets_at: 1_787_802_893,
            fetched_at: 1_787_284_456,
            credential: 'PRIVATE_CREDENTIAL',
          },
          seat4: {
            used_percent: 33.4,
            resets_at: 1_787_850_397,
            fetched_at: 1_787_376_373,
            fingerprint: 'PRIVATE_FINGERPRINT',
          },
        },
        last_error: 'PRIVATE_HELPER_DIAGNOSTIC',
      }),
    ],
  ]);

  const provider = await pocketServer.readGptUsage({
    accountStore,
    cachePath,
    now: 1_787_376_500_000,
    readdirImpl: async (requestedPath, options) => {
      assert.equal(requestedPath, accountStore);
      assert.deepEqual(options, { withFileTypes: true });
      return [
        fileEntry('.conductor-rotation-state.json'),
        fileEntry('seat4.json'),
        fileEntry('seat3.json'),
        fileEntry('notes.txt'),
        fileEntry('folder.json', false),
      ];
    },
    readFileImpl: async (requestedPath) => {
      if (!files.has(requestedPath)) throw new Error('missing fixture');
      return files.get(requestedPath);
    },
  });

  assert.deepEqual(provider, {
    id: 'gpt',
    label: 'GPT',
    available: true,
    reason: null,
    accounts: [
      {
        name: 'seat3',
        label: 'seat3',
        active: false,
        fiveHourPercent: null,
        fiveHourBlocked: false,
        fiveHourResetAt: null,
        weeklyPercent: 100,
        weeklyBlocked: true,
        weeklyResetAt: 1_787_802_893_000,
        blocked: true,
        needsLogin: false,
        stale: true,
        fetchedAt: 1_787_284_456_000,
      },
      {
        name: 'seat4',
        label: 'imalexgunnar@gmail.com',
        active: true,
        fiveHourPercent: null,
        fiveHourBlocked: false,
        fiveHourResetAt: null,
        weeklyPercent: 33,
        weeklyBlocked: false,
        weeklyResetAt: 1_787_850_397_000,
        blocked: false,
        needsLogin: false,
        stale: false,
        fetchedAt: 1_787_376_373_000,
      },
    ],
  });
  const serialized = JSON.stringify(provider);
  assert.equal(serialized.includes('PRIVATE_CREDENTIAL'), false);
  assert.equal(serialized.includes('PRIVATE_FINGERPRINT'), false);
  assert.equal(serialized.includes('PRIVATE_HELPER_DIAGNOSTIC'), false);
});

test('one unavailable usage provider never hides the other provider', async () => {
  assert.equal(typeof pocketServer.readAccountUsage, 'function');
  const gptProvider = {
    id: 'gpt',
    label: 'GPT',
    available: true,
    reason: null,
    accounts: [{ name: 'seat4', active: true, weeklyPercent: 33 }],
  };

  const usage = await pocketServer.readAccountUsage({
    now: 1_787_376_500_000,
    readClaude: async () => {
      throw new Error('PRIVATE_CLAUDE_DIAGNOSTIC');
    },
    readGpt: async () => gptProvider,
  });

  assert.deepEqual(usage, {
    available: true,
    fetchedAt: 1_787_376_500_000,
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        available: false,
        reason: 'producer_unreachable',
        accounts: [],
      },
      gptProvider,
    ],
  });
  assert.equal(JSON.stringify(usage).includes('PRIVATE_CLAUDE_DIAGNOSTIC'), false);
});

test('a future-dated GPT cache sample is stale instead of trusted', async () => {
  const accountStore = '/account-store';
  const cachePath = '/swiftbar-cache.json';
  const files = new Map([
    [`${accountStore}/.active`, 'seat4'],
    [
      cachePath,
      JSON.stringify({
        samples: {
          seat4: {
            used_percent: 12,
            fetched_at: 2_000,
          },
        },
      }),
    ],
  ]);

  const provider = await pocketServer.readGptUsage({
    accountStore,
    cachePath,
    now: 1_000_000,
    readdirImpl: async () => [fileEntry('seat4.json')],
    readFileImpl: async (requestedPath) => {
      if (!files.has(requestedPath)) throw new Error('missing fixture');
      return files.get(requestedPath);
    },
  });

  assert.equal(provider.accounts[0].stale, true);
});

test('GPT usage exposes a login-required account without leaking diagnostics', async () => {
  const accountStore = '/account-store';
  const cachePath = '/swiftbar-cache.json';
  const files = new Map([
    [`${accountStore}/.active`, 'upperfloorpod'],
    [`${accountStore}/upperfloorpod.label`, 'upperfloorpod@gmail.com'],
    [
      cachePath,
      JSON.stringify({
        next_refresh_at: 1_787_380_000,
        samples: {
          upperfloorpod: {
            needs_login: true,
            fetched_at: 1_787_376_373,
            error: 'PRIVATE_LOGIN_DIAGNOSTIC',
          },
        },
      }),
    ],
  ]);

  const provider = await pocketServer.readGptUsage({
    accountStore,
    cachePath,
    now: 1_787_376_500_000,
    readdirImpl: async () => [fileEntry('upperfloorpod.json')],
    readFileImpl: async (requestedPath) => {
      if (!files.has(requestedPath)) throw new Error('missing fixture');
      return files.get(requestedPath);
    },
  });

  assert.equal(provider.accounts[0].needsLogin, true);
  assert.equal(provider.accounts[0].weeklyPercent, null);
  assert.equal(JSON.stringify(provider).includes('PRIVATE_LOGIN_DIAGNOSTIC'), false);
});

test('GPT usage follows the producer refresh deadline before calling a sample stale', async () => {
  const accountStore = '/account-store';
  const cachePath = '/swiftbar-cache.json';
  const files = new Map([
    [`${accountStore}/.active`, 'seat4'],
    [
      cachePath,
      JSON.stringify({
        next_refresh_at: 1_787_377_000,
        samples: {
          seat4: {
            used_percent: 23,
            fetched_at: 1_787_376_000,
          },
        },
      }),
    ],
  ]);
  const readFileImpl = async (requestedPath) => {
    if (!files.has(requestedPath)) throw new Error('missing fixture');
    return files.get(requestedPath);
  };
  const common = {
    accountStore,
    cachePath,
    readdirImpl: async () => [fileEntry('seat4.json')],
    readFileImpl,
  };

  const scheduled = await pocketServer.readGptUsage({
    ...common,
    now: 1_787_376_900_000,
  });
  assert.equal(scheduled.accounts[0].stale, false);

  const overdue = await pocketServer.readGptUsage({
    ...common,
    now: 1_787_377_001_000,
  });
  assert.equal(overdue.accounts[0].stale, true);
});
