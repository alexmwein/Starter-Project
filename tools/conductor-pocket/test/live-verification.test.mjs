import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  recoverAttestedRelay,
  verifyPublicRelease,
} from '../scripts/lib/live-verification.mjs';

const source = await fs.readFile(
  new URL('../scripts/verify-live.mjs', import.meta.url),
  'utf8',
);

test('live recovery is globally locked and mutates only an attested launchd job', () => {
  assert.doesNotMatch(source, /pkill/);
  const recoveryStart = source.indexOf('async function recover(');
  const recoveryEnd = source.indexOf('\n}', recoveryStart);
  const recovery = source.slice(recoveryStart, recoveryEnd);
  const lock = recovery.indexOf('await withOperationLock(');
  const attestedRecovery = recovery.indexOf('await recoverAttestedRelay(');

  assert.ok(recoveryStart >= 0);
  assert.ok(lock >= 0);
  assert.ok(attestedRecovery > lock);
});

test('attested recovery proves ownership before the exact shutdown sequence', async () => {
  const calls = [];
  const profile = await recoverAttestedRelay({
    configPath: '/private/conductor-pocket/config.json',
    port: 4317,
    attest: async () => {
      calls.push('attest');
      return { pid: 42 };
    },
    bootout: async () => {
      calls.push('bootout');
      return true;
    },
    waitForRemoval: async () => calls.push('launchd-removed'),
    waitForShutdown: async ({ expectedPid }) => {
      calls.push(`shutdown:${expectedPid}`);
    },
    bootstrap: async () => calls.push('bootstrap'),
  });

  assert.equal(profile.pid, 42);
  assert.deepEqual(calls, [
    'attest',
    'bootout',
    'launchd-removed',
    'shutdown:42',
    'bootstrap',
  ]);

  const forbiddenCalls = [];
  await assert.rejects(
    recoverAttestedRelay({
      configPath: '/private/conductor-pocket/config.json',
      port: 4317,
      attest: async () => {
        throw new Error('attestation failed');
      },
      bootout: async () => forbiddenCalls.push('bootout'),
      waitForRemoval: async () => forbiddenCalls.push('launchd-removed'),
      waitForShutdown: async () => forbiddenCalls.push('shutdown'),
      bootstrap: async () => forbiddenCalls.push('bootstrap'),
    }),
    /attestation failed/,
  );
  assert.deepEqual(forbiddenCalls, []);
});

test('public release proof checks exact health identity and a cache-busted document', async () => {
  const requests = [];
  const expected = {
    version: '0.2.0',
    configRevision: 'config-123',
    shellRevision: 'shell-456',
  };
  const result = await verifyPublicRelease({
    origin: 'https://pocket.test',
    expected,
    now: () => 789,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      const pathname = new URL(url).pathname;
      if (pathname === '/api/health') {
        return new Response(
          JSON.stringify({ ok: true, ...expected }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        `<meta name="conductor-pocket-shell-revision" content="${expected.shellRevision}">`,
        { headers: { 'Content-Type': 'text/html' } },
      );
    },
  });

  assert.equal(result.health.shellRevision, expected.shellRevision);
  assert.equal(result.documentRevision, expected.shellRevision);
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    'https://pocket.test/api/health?appRevision=shell-456-789',
  );
  assert.equal(
    requests[1].url,
    'https://pocket.test/?appRevision=shell-456-789',
  );
  assert.equal(requests.every(({ options }) => options.cache === 'no-store'), true);
});

test('public release proof rejects every health identity mismatch before loading HTML', async () => {
  const expected = {
    version: '0.2.0',
    configRevision: 'config-123',
    shellRevision: 'shell-456',
  };
  for (const field of ['version', 'configRevision', 'shellRevision']) {
    let requestCount = 0;
    await assert.rejects(
      verifyPublicRelease({
        origin: 'https://pocket.test',
        expected,
        now: () => 789,
        fetchImpl: async () => {
          requestCount += 1;
          return new Response(
            JSON.stringify({ ok: true, ...expected, [field]: 'stale' }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        },
      }),
      /public health identity mismatch/,
    );
    assert.equal(requestCount, 1);
  }
});

test('public release proof rejects a stale document revision marker', async () => {
  const expected = {
    version: '0.2.0',
    configRevision: 'config-123',
    shellRevision: 'shell-456',
  };
  await assert.rejects(
    verifyPublicRelease({
      origin: 'https://pocket.test',
      expected,
      now: () => 789,
      fetchImpl: async (url) => {
        if (new URL(url).pathname === '/api/health') {
          return new Response(
            JSON.stringify({ ok: true, ...expected }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          '<meta name="conductor-pocket-shell-revision" content="stale-shell">',
          { headers: { 'Content-Type': 'text/html' } },
        );
      },
    }),
    /public document revision mismatch/,
  );
});

test('live verifier requires the public health and document proof', () => {
  assert.match(source, /await verifyPublicRelease\(\{/);
  assert.match(
    source,
    /version: APP_VERSION[\s\S]*configRevision: configRevision\(config\)[\s\S]*shellRevision: SHELL_REVISION/,
  );
  assert.doesNotMatch(source, /async function reachable\(/);
});

test('the package check syntax-checks the live verification helper', async () => {
  const packageSource = await fs.readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  );
  assert.match(
    packageSource,
    /node --check scripts\/lib\/live-verification\.mjs/,
  );
});
