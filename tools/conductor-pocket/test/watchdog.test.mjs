import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  COOLDOWN_MS,
  DISK_CRITICAL_BYTES,
  DISK_WARN_BYTES,
  SESSION_WARN_MS,
  evaluateSnapshot,
  planNotifications,
} from '../../pocket-watchdog/src/checks.mjs';
import {
  SAFE_IMESSAGE_PATH,
  deliverNotifications,
} from '../../pocket-watchdog/src/notifications.mjs';
import {
  codexRegistrySnapshot,
  hasEnabledFunnel,
} from '../../pocket-watchdog/src/system.mjs';

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-29T18:00:00.000Z');
const execFile = promisify(nodeExecFile);

function goodSnapshot() {
  return {
    diskFreeBytes: 40 * GB,
    relay: {
      bindHost: '127.0.0.1',
      loopback: { ok: true, shellRevision: 'shell-r1' },
      installedShellRevision: 'shell-r1',
      tailnetStatus: 200,
      launchLoaded: true,
      funnelEnabled: false,
    },
    devices: [
      {
        id: 'phone-1',
        name: 'Alex iPhone',
        trustedUntil: new Date(NOW + 20 * DAY).toISOString(),
        sessionExpiresAt: new Date(NOW + 21 * DAY).toISOString(),
      },
    ],
    sidebar: {
      ok: true,
      activeRepositories: ['Quickstart'],
      projects: [{ name: 'Quickstart', collapsed: false }],
    },
    codex: {
      readable: true,
      vaultSeats: ['primary'],
      routes: [{ name: 'secondary', hasAuth: true }],
    },
    load5: 3,
  };
}

function issueIds(snapshot) {
  return evaluateSnapshot(snapshot, NOW).issues.map((issue) => issue.id);
}

test('watchdog thresholds stay pinned to the incident boundaries', () => {
  assert.equal(DISK_WARN_BYTES, 25 * GB);
  assert.equal(DISK_CRITICAL_BYTES, 10 * GB);
  assert.equal(SESSION_WARN_MS, 5 * DAY);
  assert.equal(COOLDOWN_MS, 6 * 60 * 60 * 1000);
});

test('every watchdog check fires on its bad state and clears on green', () => {
  const cases = [
    ['disk', (value) => { value.diskFreeBytes = 24 * GB; }, 'disk:free'],
    ['disk critical', (value) => { value.diskFreeBytes = 9 * GB; }, 'disk:free'],
    ['relay loopback', (value) => { value.relay.loopback.ok = false; }, 'relay:loopback'],
    ['shell revision', (value) => { value.relay.loopback.shellRevision = 'old'; }, 'relay:revision'],
    ['tailnet origin', (value) => { value.relay.tailnetStatus = 503; }, 'relay:tailnet'],
    ['relay launchd', (value) => { value.relay.launchLoaded = false; }, 'relay:launchd'],
    ['Funnel', (value) => { value.relay.funnelEnabled = true; }, 'relay:funnel'],
    ['loopback binding', (value) => { value.relay.bindHost = '0.0.0.0'; }, 'relay:binding'],
    ['trust expiry', (value) => { value.devices[0].trustedUntil = new Date(NOW + 2 * DAY).toISOString(); }, 'session:phone-1'],
    ['hard session expiry', (value) => { value.devices[0].sessionExpiresAt = new Date(NOW - DAY).toISOString(); }, 'session:phone-1'],
    ['collapsed sidebar', (value) => { value.sidebar.projects[0].collapsed = true; }, 'sidebar:Quickstart'],
    ['missing project row', (value) => { value.sidebar.projects = []; }, 'sidebar:missing:Quickstart'],
    ['sidebar read', (value) => { value.sidebar.ok = false; }, 'sidebar:unreadable'],
    ['duplicate Codex seat', (value) => { value.codex.routes[0].name = 'primary'; }, 'codex:duplicate:primary'],
    ['missing route auth', (value) => { value.codex.routes[0].hasAuth = false; }, 'codex:missing-auth:secondary'],
    ['Codex registry read', (value) => { value.codex.readable = false; }, 'codex:registry-unreadable'],
    ['Mac load', (value) => { value.load5 = 26; }, 'load:high'],
  ];

  for (const [name, mutate, expected] of cases) {
    const bad = goodSnapshot();
    mutate(bad);
    const badReport = evaluateSnapshot(bad, NOW);
    assert.ok(
      badReport.issues.some((entry) => entry.id === expected),
      `${name} did not fire`,
    );
    assert.deepEqual(issueIds(goodSnapshot()), [], `${name} did not clear`);
    const alerted = planNotifications(
      { version: 1, issues: {} },
      badReport.issues,
      NOW,
    );
    const cleared = planNotifications(
      alerted.nextState,
      [],
      NOW + 1,
    );
    assert.ok(
      cleared.notifications.some(
        (notification) =>
          notification.type === 'recovery' && notification.id === expected,
      ),
      `${name} did not send recovery`,
    );
  }
});

test('watchdog messages name both the problem and a concrete fix', () => {
  const bad = goodSnapshot();
  bad.diskFreeBytes = 9 * GB;
  bad.relay.loopback.ok = false;
  bad.devices[0].trustedUntil = new Date(NOW - 1).toISOString();
  bad.sidebar.projects[0].collapsed = true;
  bad.codex.routes = [{ name: 'primary', hasAuth: false }];
  bad.load5 = 30;

  const { issues } = evaluateSnapshot(bad, NOW);
  for (const issue of issues) {
    assert.match(issue.message, /^Pocket:/);
    assert.match(issue.recovery, /^Pocket recovered:/);
    assert.ok(issue.message.length <= 280, issue.id);
  }
  assert.match(
    issues.find((issue) => issue.id === 'session:phone-1').message,
    /expired.*Face ID/i,
  );
});

test('cooldown suppresses duplicates and clearing produces one recovery', () => {
  const issue = evaluateSnapshot(
    { ...goodSnapshot(), load5: 30 },
    NOW,
  ).issues[0];
  const first = planNotifications({ version: 1, issues: {} }, [issue], NOW);
  assert.deepEqual(first.notifications.map((item) => item.type), ['alert']);

  const duplicate = planNotifications(first.nextState, [issue], NOW + DAY / 12);
  assert.deepEqual(duplicate.notifications, []);

  const afterCooldown = planNotifications(
    duplicate.nextState,
    [issue],
    NOW + COOLDOWN_MS,
  );
  assert.deepEqual(afterCooldown.notifications.map((item) => item.type), ['alert']);

  const cleared = planNotifications(afterCooldown.nextState, [], NOW + COOLDOWN_MS + 1);
  assert.deepEqual(cleared.notifications.map((item) => item.type), ['recovery']);
  assert.deepEqual(cleared.nextState.issues, {});

  const staysGreen = planNotifications(cleared.nextState, [], NOW + COOLDOWN_MS + 2);
  assert.deepEqual(staysGreen.notifications, []);
});

test('an unreadable sidebar never invents a recovery', () => {
  const collapsed = goodSnapshot();
  collapsed.sidebar.projects[0].collapsed = true;
  const firstReport = evaluateSnapshot(collapsed, NOW);
  const first = planNotifications(
    { version: 1, issues: {} },
    firstReport.issues,
    NOW,
  );
  const unknown = goodSnapshot();
  unknown.sidebar.ok = false;
  const unknownReport = evaluateSnapshot(unknown, NOW + 1);
  const held = planNotifications(
    first.nextState,
    unknownReport.issues,
    NOW + 1,
    { unresolvedIssuePrefixes: unknownReport.unresolvedIssuePrefixes },
  );
  assert.deepEqual(
    held.notifications.map((notification) => [notification.type, notification.id]),
    [['alert', 'sidebar:unreadable']],
  );
  assert.equal(
    held.notifications.some((notification) => notification.type === 'recovery'),
    false,
  );
  assert.ok(held.nextState.issues['sidebar:Quickstart']);
});

test('notification transport can only invoke safe-imessage for Alex', async () => {
  const calls = [];
  await deliverNotifications(
    [{ type: 'alert', message: 'Pocket: simulated issue. Fix it.' }],
    {
      execFile: async (...argumentsList) => { calls.push(argumentsList); },
    },
  );
  assert.deepEqual(calls, [[
    SAFE_IMESSAGE_PATH,
    ['--recipient', 'alex', '--message', 'Pocket: simulated issue. Fix it.'],
    { timeout: 30_000 },
  ]]);

  const source = await fs.readFile(
    new URL('../../pocket-watchdog/src/notifications.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /osascript|AppleScript|Messages\.app/);
});

test('Codex registry collector detects only real vault seats and route auth', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-watchdog-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const routes = path.join(root, 'routes');
  await fs.mkdir(vault);
  await fs.mkdir(path.join(routes, 'primary'), { recursive: true });
  await fs.mkdir(path.join(routes, 'secondary'), { recursive: true });
  await fs.writeFile(path.join(vault, 'primary.json'), '{}');
  await fs.writeFile(path.join(vault, '.watchdog-status.json'), '{}');
  await fs.writeFile(path.join(vault, 'ignored.json.routed'), 'routed');
  await fs.writeFile(path.join(routes, 'primary', 'auth.json'), '{}');

  assert.deepEqual(
    await codexRegistrySnapshot({ vaultDirectory: vault, routesDirectory: routes }),
    {
      readable: true,
      vaultSeats: ['primary'],
      routes: [
        { name: 'primary', hasAuth: true },
        { name: 'secondary', hasAuth: false },
      ],
    },
  );
});

test('Funnel collector rejects any nested enabled AllowFunnel value', () => {
  assert.equal(hasEnabledFunnel({ Web: {}, AllowFunnel: {} }), false);
  assert.equal(
    hasEnabledFunnel({ nested: { AllowFunnel: { 'pocket.example:443': true } } }),
    true,
  );
});

test('watchdog LaunchAgent runs every ten minutes and exposes the doctor CLI', async () => {
  const installer = await fs.readFile(
    new URL('../../pocket-watchdog/scripts/install.mjs', import.meta.url),
    'utf8',
  );
  const packageDocument = JSON.parse(await fs.readFile(
    new URL('../../pocket-watchdog/package.json', import.meta.url),
    'utf8',
  ));
  assert.match(installer, /com\.ovo\.pocket-watchdog/);
  assert.match(installer, /<key>StartInterval<\/key><integer>600<\/integer>/);
  assert.match(installer, /<string>run<\/string>/);
  assert.match(installer, /pocket-doctor/);
  assert.match(installer, /Pocket watchdog`\);/);
  assert.match(installer, /\} doctor \"\$@\"/);
  assert.equal(
    packageDocument.scripts.doctor,
    'node --no-warnings=ExperimentalWarning src/cli.mjs doctor',
  );
});

test('prepared doctor runs read-only from a versioned runtime', async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-watchdog-home-'));
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  const packageRoot = new URL('../../pocket-watchdog/', import.meta.url);
  await execFile(
    process.execPath,
    ['scripts/install.mjs', '--prepare-only'],
    {
      cwd: fileURLToPath(packageRoot),
      env: { ...process.env, POCKET_WATCHDOG_HOME: home },
      timeout: 10_000,
    },
  );
  const doctor = path.join(home, '.local', 'bin', 'pocket-doctor');
  await assert.rejects(
    execFile(
      doctor,
      ['--config', path.join(home, 'missing-config.json')],
      { timeout: 10_000 },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /Watchdog preflight: collector failed/);
      assert.doesNotMatch(error.stdout, /Notifications sent/);
      return true;
    },
  );
});
