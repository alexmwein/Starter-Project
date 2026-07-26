import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertSupportedStatusVersion,
  launchdNotFound,
  launchdArguments,
  removeVerifiedStaleSocket,
  sidecarCliArguments,
  sidecarDaemonArguments,
  statusVersion,
  validatedSidecarAuthUrl,
  versionAtLeast,
  waitForSidecarLoginOutcome,
  waitForSidecarResponse,
  xml,
} from '../scripts/lib/sidecar.mjs';

test('every dedicated-node CLI command is bound to its private socket', () => {
  assert.deepEqual(
    sidecarCliArguments(
      ['serve', 'status', '--json'],
      '/private/conductor-pocket/tailscaled.sock',
    ),
    [
      '--socket=/private/conductor-pocket/tailscaled.sock',
      'serve',
      'status',
      '--json',
    ],
  );
  assert.throws(
    () => sidecarCliArguments(['status'], 'relative.sock'),
    /must be absolute/,
  );
});

test('dedicated daemon launch arguments expose only the audited userspace socket', () => {
  assert.deepEqual(
    sidecarDaemonArguments('/opt/tailscale/bin/tailscaled', {
      stateDirectory: '/private/conductor-pocket/tailscale',
      socketPath: '/private/conductor-pocket/tailscaled.sock',
    }),
    [
      '/opt/tailscale/bin/tailscaled',
      '--tun=userspace-networking',
      '--statedir=/private/conductor-pocket/tailscale',
      '--socket=/private/conductor-pocket/tailscaled.sock',
      '--port=0',
    ],
  );
});

test('loaded launchd arguments are parsed and compared independently of the plist', () => {
  assert.deepEqual(
    launchdArguments(`
arguments = {
  /opt/tailscale/bin/tailscaled
  --tun=userspace-networking
  --socket=/private/tailscaled.sock
}
working directory = /private
`),
    [
      '/opt/tailscale/bin/tailscaled',
      '--tun=userspace-networking',
      '--socket=/private/tailscaled.sock',
    ],
  );
  assert.equal(launchdArguments('state = running'), null);
});

test('an already-unloaded launchd job is recognized for print and bootout', () => {
  assert.equal(
    launchdNotFound({
      code: 113,
      stderr:
        'Bad request.\\nCould not find service "example" in domain for user gui: 501\\n',
    }),
    true,
  );
  assert.equal(
    launchdNotFound({
      code: 3,
      stderr: 'Boot-out failed: 3: No such process\\n',
    }),
    true,
  );
  assert.equal(
    launchdNotFound({
      code: 5,
      stderr: 'Boot-out failed: 5: Input/output error\\n',
    }),
    false,
  );
});

test('LaunchAgent XML values are escaped', () => {
  assert.equal(xml('a&<b>"\''), 'a&amp;&lt;b&gt;&quot;&apos;');
});

test('the sidecar refuses Tailscale builds older than the security floor', () => {
  assert.equal(versionAtLeast('1.98.9', '1.98.9'), true);
  assert.equal(versionAtLeast('1.100.0', '1.98.9'), true);
  assert.equal(versionAtLeast('1.98.8', '1.98.9'), false);
  assert.equal(versionAtLeast('unknown', '1.98.9'), false);
  assert.equal(
    statusVersion({ Version: '1.98.9-t4fb758c39-g200941d74' }),
    '1.98.9',
  );
  assert.equal(
    assertSupportedStatusVersion({
      Version: '1.98.9-t4fb758c39-g200941d74',
    }),
    '1.98.9',
  );
  assert.throws(
    () => assertSupportedStatusVersion({ Version: '1.98.8-old' }),
    /running Tailscale daemon/,
  );
});

test('installer waits for a real socket-scoped daemon response', async () => {
  let reads = 0;
  const status = await waitForSidecarResponse({
    readStatus: async () => {
      reads += 1;
      if (reads < 3) throw new Error('connection refused');
      return { BackendState: 'NeedsLogin' };
    },
    delayMs: 0,
    sleep: async () => {},
  });
  assert.equal(reads, 3);
  assert.equal(status.BackendState, 'NeedsLogin');
});

test('sidecar login accepts only an exact Tailscale HTTPS authorization URL', () => {
  assert.equal(
    validatedSidecarAuthUrl('https://login.tailscale.com/a/Abc_123-xyz'),
    'https://login.tailscale.com/a/Abc_123-xyz',
  );
  assert.equal(validatedSidecarAuthUrl(''), null);
  for (const value of [
    'http://login.tailscale.com/a/abcdef',
    'https://login.tailscale.com.evil.example/a/abcdef',
    'https://user@login.tailscale.com/a/abcdef',
    'https://login.tailscale.com:443/a/abcdef',
    'https://login.tailscale.com:444/a/abcdef',
    ' https://login.tailscale.com/a/abcdef',
    'https://login.tailscale.com/a/abcdef?continue=evil',
    'https://login.tailscale.com/a/abcdef#fragment',
    'https://login.tailscale.com/a/abcdef%2Fextra',
    'https://login.tailscale.com/a/abcdef/extra',
    'https://login.tailscale.com/admin/abcdef',
  ]) {
    assert.throws(
      () => validatedSidecarAuthUrl(value),
      /untrusted login URL/,
    );
  }
});

test('sidecar login returns once the daemon owns a pending authorization', async () => {
  const statuses = [
    { BackendState: 'NeedsLogin', AuthURL: '' },
    {
      BackendState: 'NeedsLogin',
      AuthURL: 'https://login.tailscale.com/a/abcdef123456',
    },
  ];
  const outcome = await waitForSidecarLoginOutcome({
    readStatus: async () => statuses.shift(),
    pollDelayMs: 0,
    sleep: async () => {},
  });
  assert.equal(
    outcome.authUrl,
    'https://login.tailscale.com/a/abcdef123456',
  );
  assert.equal(outcome.status.BackendState, 'NeedsLogin');
});

test('sidecar login recognizes approval without requiring the helper process', async () => {
  const outcome = await waitForSidecarLoginOutcome({
    readStatus: async () => ({ BackendState: 'Running', AuthURL: '' }),
    pollDelayMs: 0,
    sleep: async () => {},
  });
  assert.equal(outcome.authUrl, null);
  assert.equal(outcome.status.BackendState, 'Running');
});

test('sidecar login deadline bounds a stalled status reader', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    waitForSidecarLoginOutcome({
      readStatus: async () => new Promise(() => {}),
      deadlineMs: 20,
      statusTimeoutMs: 5,
      pollDelayMs: 1,
    }),
    /stopped answering during login/,
  );
  assert.ok(Date.now() - startedAt < 200);
});

test('installer removes only a socket proven stale by a failed probe', async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-socket-'),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, 'tailscaled.sock');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  context.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  );

  assert.equal(
    await removeVerifiedStaleSocket(socketPath, {
      probe: async () => {
        const error = new Error('connection refused');
        throw error;
      },
    }),
    true,
  );
  await assert.rejects(fs.lstat(socketPath), (error) => error.code === 'ENOENT');
});

test('installer refuses to unlink a socket that still answers', async () => {
  await assert.rejects(
    removeVerifiedStaleSocket('/verified/socket', {
      lstat: async () => ({ isSocket: () => true }),
      probe: async () => ({ BackendState: 'Running' }),
      unlink: async () => {
        throw new Error('must not unlink');
      },
    }),
    /still answers/,
  );
});
