import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const helperUrl = new URL(
  '../scripts/lib/runtime-retention.mjs',
  import.meta.url,
);

async function loadRetentionHelper() {
  return import(helperUrl);
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

test('runtime retention keeps the active runtime and newest rollback', async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-runtimes-'),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeNames = [
    'runtime-0.2.0-1700000000000-100',
    'runtime-0.2.0-1700000001000-101',
    'runtime-0.2.0-1700000002000-102',
    'runtime-0.2.0-1700000003000-103',
  ];
  for (const name of runtimeNames) {
    await fs.mkdir(path.join(root, name));
  }
  const activeRuntime = path.join(root, runtimeNames[3]);
  const { pruneStableRuntimes } = await loadRetentionHelper();

  const result = await pruneStableRuntimes(root, activeRuntime);

  assert.deepEqual(
    result.removed.map((entry) => path.basename(entry)),
    runtimeNames.slice(0, 2),
  );
  assert.equal(await pathExists(activeRuntime), true);
  assert.equal(await pathExists(path.join(root, runtimeNames[2])), true);
  assert.equal(await pathExists(path.join(root, runtimeNames[1])), false);
  assert.equal(await pathExists(path.join(root, runtimeNames[0])), false);
});

test('runtime retention preserves the configured rollback over a newer orphan', async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-runtimes-'),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const rollbackRuntime = path.join(
    root,
    'runtime-0.2.0-1700000001000-101',
  );
  const failedOrphan = path.join(
    root,
    'runtime-0.2.0-1700000002000-102',
  );
  const activeRuntime = path.join(
    root,
    'runtime-0.2.0-1700000003000-103',
  );
  for (const runtime of [rollbackRuntime, failedOrphan, activeRuntime]) {
    await fs.mkdir(runtime);
  }
  const { pruneStableRuntimes } = await loadRetentionHelper();

  await pruneStableRuntimes(root, activeRuntime, { rollbackRuntime });

  assert.equal(await pathExists(activeRuntime), true);
  assert.equal(await pathExists(rollbackRuntime), true);
  assert.equal(await pathExists(failedOrphan), false);
});

test('runtime retention never removes symlinks, files, or unrelated directories', async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-runtimes-'),
  );
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-outside-'),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  const activeRuntime = path.join(
    root,
    'runtime-0.2.0-1700000003000-103',
  );
  const rollbackRuntime = path.join(
    root,
    'runtime-0.2.0-1700000002000-102',
  );
  const staleRuntime = path.join(
    root,
    'runtime-0.2.0-1700000001000-101',
  );
  const linkedRuntime = path.join(
    root,
    'runtime-0.2.0-1700000000000-100',
  );
  const unrelatedDirectory = path.join(root, 'runtime-manual-backup');
  const conformingFile = path.join(
    root,
    'runtime-0.2.0-1699999999000-99',
  );
  await fs.mkdir(activeRuntime);
  await fs.mkdir(rollbackRuntime);
  await fs.mkdir(staleRuntime);
  await fs.mkdir(unrelatedDirectory);
  await fs.writeFile(conformingFile, 'keep');
  await fs.writeFile(path.join(outside, 'sentinel'), 'keep');
  await fs.symlink(outside, linkedRuntime);
  const { pruneStableRuntimes } = await loadRetentionHelper();

  await pruneStableRuntimes(root, activeRuntime);

  assert.equal(await pathExists(staleRuntime), false);
  assert.equal((await fs.lstat(linkedRuntime)).isSymbolicLink(), true);
  assert.equal(await pathExists(path.join(outside, 'sentinel')), true);
  assert.equal((await fs.lstat(conformingFile)).isFile(), true);
  assert.equal((await fs.lstat(unrelatedDirectory)).isDirectory(), true);
});

test('runtime retention fails closed when the active runtime is not a real direct child', async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-runtimes-'),
  );
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-outside-'),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  const staleRuntime = path.join(
    root,
    'runtime-0.2.0-1700000000000-100',
  );
  await fs.mkdir(staleRuntime);
  const { pruneStableRuntimes } = await loadRetentionHelper();

  await assert.rejects(
    pruneStableRuntimes(root, outside),
    /active runtime must be a real direct child/,
  );
  assert.equal(await pathExists(staleRuntime), true);
});

test('loaded launchd arguments select the actual rollback after a crashed install', async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-runtimes-'),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const loadedRuntime = path.join(
    root,
    'runtime-0.2.0-1700000001000-101',
  );
  const abandonedPlistRuntime = path.join(
    root,
    'runtime-0.2.0-1700000002000-102',
  );
  await fs.mkdir(path.join(loadedRuntime, 'src'), { recursive: true });
  await fs.writeFile(path.join(loadedRuntime, 'src', 'cli.mjs'), '');
  await fs.mkdir(abandonedPlistRuntime);
  const configPath = '/private/conductor-pocket/config.json';
  const { runtimeForLoadedLaunchdJob } = await loadRetentionHelper();

  const rollbackRuntime = await runtimeForLoadedLaunchdJob(
    root,
    [
      '/opt/homebrew/bin/node',
      '--no-warnings=ExperimentalWarning',
      path.join(loadedRuntime, 'src', 'cli.mjs'),
      'serve',
      '--config',
      configPath,
    ],
    {
      configPath,
      workingDirectory: loadedRuntime,
      access: async () => {},
    },
  );

  assert.equal(rollbackRuntime, await fs.realpath(loadedRuntime));
  assert.notEqual(rollbackRuntime, abandonedPlistRuntime);
});

test('loaded launchd validation rejects a mismatched working directory', async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-runtimes-'),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const loadedRuntime = path.join(
    root,
    'runtime-0.2.0-1700000001000-101',
  );
  const abandonedRuntime = path.join(
    root,
    'runtime-0.2.0-1700000002000-102',
  );
  await fs.mkdir(path.join(loadedRuntime, 'src'), { recursive: true });
  await fs.writeFile(path.join(loadedRuntime, 'src', 'cli.mjs'), '');
  await fs.mkdir(abandonedRuntime);
  const configPath = '/private/conductor-pocket/config.json';
  const { runtimeForLoadedLaunchdJob } = await loadRetentionHelper();

  await assert.rejects(
    runtimeForLoadedLaunchdJob(
      root,
      [
        '/opt/homebrew/bin/node',
        '--no-warnings=ExperimentalWarning',
        path.join(loadedRuntime, 'src', 'cli.mjs'),
        'serve',
        '--config',
        configPath,
      ],
      {
        configPath,
        workingDirectory: abandonedRuntime,
        access: async () => {},
      },
    ),
    /working directory must match the loaded rollback runtime/,
  );
});

test('loaded launchd validation rejects an interpreter that is no longer executable', async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'conductor-pocket-runtimes-'),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const loadedRuntime = path.join(
    root,
    'runtime-0.2.0-1700000001000-101',
  );
  await fs.mkdir(path.join(loadedRuntime, 'src'), { recursive: true });
  await fs.writeFile(path.join(loadedRuntime, 'src', 'cli.mjs'), '');
  const configPath = '/private/conductor-pocket/config.json';
  const interpreterPath = '/missing/version-pinned/node';
  const accessChecks = [];
  const { runtimeForLoadedLaunchdJob } = await loadRetentionHelper();

  await assert.rejects(
    runtimeForLoadedLaunchdJob(
      root,
      [
        interpreterPath,
        '--no-warnings=ExperimentalWarning',
        path.join(loadedRuntime, 'src', 'cli.mjs'),
        'serve',
        '--config',
        configPath,
      ],
      {
        configPath,
        workingDirectory: loadedRuntime,
        access: async (target, mode) => {
          accessChecks.push({ target, mode });
          const error = new Error('missing interpreter');
          error.code = 'ENOENT';
          throw error;
        },
      },
    ),
    /loaded relay interpreter must remain executable/,
  );
  assert.deepEqual(accessChecks, [
    { target: interpreterPath, mode: fs.constants.X_OK },
  ]);
});

test('failed cutover restores the validated loaded profile over an abandoned plist', async () => {
  const { rollbackPlistForLoadedRelay } = await loadRetentionHelper();
  const loadedProfile = '<plist>runtime-a</plist>';
  const abandonedDiskProfile = '<plist>runtime-b</plist>';

  assert.equal(
    rollbackPlistForLoadedRelay({
      previousJobWasLoaded: true,
      previousLoadedPlist: loadedProfile,
      previousPlist: abandonedDiskProfile,
    }),
    loadedProfile,
  );
});

test('relay installer prunes only after the replacement relay is healthy', async () => {
  const source = await fs.readFile(
    new URL('../scripts/install-relay.mjs', import.meta.url),
    'utf8',
  );
  const installStart = source.indexOf('async function install()');
  const healthCheck = source.indexOf('await waitForRelay(config);', installStart);
  const retentionCall = source.indexOf(
    'await pruneStableRuntimes(',
    installStart,
  );
  const loadedJobRead = source.indexOf("'print',", installStart);
  const loadedRuntimeValidation = source.indexOf(
    'await runtimeForLoadedLaunchdJob(',
    installStart,
  );
  const plistReplacement = source.indexOf(
    'await writePrivateFile(launchAgentPath, plist);',
    installStart,
  );

  assert.ok(installStart >= 0);
  assert.ok(loadedJobRead > installStart);
  assert.ok(loadedRuntimeValidation > loadedJobRead);
  assert.ok(plistReplacement > loadedRuntimeValidation);
  assert.match(
    source.slice(loadedRuntimeValidation, plistReplacement),
    /if \(!previousLoadedRuntimeKnown\)[\s\S]*throw new Error/,
  );
  assert.ok(healthCheck > installStart);
  assert.ok(retentionCall > healthCheck);
  assert.match(
    source.slice(plistReplacement, healthCheck),
    /previousJobWasLoaded !== previousJobWasLoadedAtSnapshot[\s\S]*previousLoadedRuntimeKnown = false/,
  );
  assert.match(
    source.slice(installStart, retentionCall + 240),
    /rollbackRuntime: previousLoadedRuntimeDirectory/,
  );
  assert.match(
    source.slice(plistReplacement, retentionCall),
    /rollbackPlistForLoadedRelay\([\s\S]*previousLoadedPlist[\s\S]*writePrivateFile\(launchAgentPath, rollbackPlist\)/,
  );
});
