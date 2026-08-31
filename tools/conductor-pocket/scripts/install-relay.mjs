import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { configRevision, loadConfig } from '../src/config.mjs';
import {
  APP_VERSION,
  SHELL_REVISION,
} from '../src/constants.mjs';
import { withOperationLock } from '../src/operation-lock.mjs';
import { RELAY_EXIT_TIMEOUT_SECONDS } from '../src/timing.mjs';
import {
  RELAY_LAUNCHD_REMOVAL_TIMEOUT_MS,
  bootoutIfLoaded,
  launchdArguments,
  launchdNotFound,
  waitForLaunchdRemoval,
  writePrivateFile,
} from './lib/sidecar.mjs';
import {
  pruneStableRuntimes,
  rollbackPlistForLoadedRelay,
  runtimeForLoadedLaunchdJob,
} from './lib/runtime-retention.mjs';

const execFileAsync = promisify(execFile);

// process.execPath on a Homebrew install is a VERSION-PINNED Cellar path
// (/opt/homebrew/Cellar/node/26.0.0/bin/node) and `brew upgrade node` deletes
// it. Baking that into the LaunchAgent means a routine upgrade silently kills
// the relay forever, with no error anyone sees, which for an operator who is
// not at the Mac means the bridge is simply gone until they get home.
// Homebrew re-points the unversioned symlink on upgrade, so prefer a stable
// sibling that resolves to the SAME binary today, and fall back to execPath
// (with a warning) rather than guessing.
const STABLE_INTERPRETER_CANDIDATES = [
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
];

async function resolveInterpreterPath() {
  let actual;
  try {
    actual = await fs.realpath(process.execPath);
  } catch {
    return process.execPath;
  }
  for (const candidate of STABLE_INTERPRETER_CANDIDATES) {
    try {
      if ((await fs.realpath(candidate)) !== actual) continue;
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Candidate missing, pointing elsewhere, or not executable.
    }
  }
  console.warn(
    `[install-relay] no stable interpreter symlink resolves to ${actual}; ` +
      'pinning the versioned path, which a package-manager upgrade may delete.',
  );
  return process.execPath;
}
const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RELAY_START_ATTEMPTS = 150;
const configPath =
  process.env.CONDUCTOR_POCKET_CONFIG ||
  path.join(os.homedir(), '.config', 'conductor-pocket', 'config.json');
const label = 'com.ovo.conductor-pocket';
const launchAgentPath = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  `${label}.plist`,
);

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function relayLaunchAgentPlist({
  interpreterPath,
  cliPath,
  runtimeDirectory,
  relayConfigPath,
  stdoutPath,
  stderrPath,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(interpreterPath)}</string>
    <string>--no-warnings=ExperimentalWarning</string>
    <string>${xml(cliPath)}</string>
    <string>serve</string>
    <string>--config</string>
    <string>${xml(relayConfigPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(runtimeDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <!-- Unconditional: with SuccessfulExit=false, a clean SIGTERM (exit 0)
       left the relay permanently down until a manual kickstart, and the
       phone cannot even report why. Deliberate stops go through launchctl
       bootout, which unloads the job entirely, so this never fights an
       intentional shutdown. -->
  <true/>
  <key>ExitTimeOut</key>
  <!-- Above the relay's own force-exit deadline: a send's automation can
       legitimately use its full retry budget, and launchd's default SIGKILL would preempt
       the graceful drain that keeps a dying relay from orphaning an
       osascript child mid-type. -->
  <integer>${RELAY_EXIT_TIMEOUT_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrPath)}</string>
</dict>
</plist>
`;
}

async function run(executable, argumentsList, options = {}) {
  return execFileAsync(executable, argumentsList, {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
}

async function npmInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && path.isAbsolute(npmExecPath)) {
    try {
      await fs.access(npmExecPath);
      return {
        executable: process.execPath,
        prefix: [npmExecPath],
      };
    } catch {
      // Fall through to standalone npm executables.
    }
  }
  const candidates = [
    path.join(path.dirname(process.execPath), 'npm'),
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return { executable: candidate, prefix: [] };
    } catch {
      // Try the next known location.
    }
  }
  throw new Error('npm was not found; it is required to build the stable relay runtime');
}

async function installStableRuntime(dataDirectory) {
  const runtimeParent = path.join(dataDirectory, 'runtimes');
  await fs.mkdir(runtimeParent, { recursive: true, mode: 0o700 });
  await fs.chmod(runtimeParent, 0o700);
  const suffix = `${APP_VERSION}-${Date.now()}-${process.pid}`;
  const stagingDirectory = path.join(runtimeParent, `.installing-${suffix}`);
  const runtimeDirectory = path.join(runtimeParent, `runtime-${suffix}`);
  await fs.mkdir(stagingDirectory, { mode: 0o700 });
  for (const entry of ['package.json', 'package-lock.json']) {
    await fs.copyFile(
      path.join(packageRoot, entry),
      path.join(stagingDirectory, entry),
    );
  }
  for (const entry of ['src', 'public']) {
    await fs.cp(path.join(packageRoot, entry), path.join(stagingDirectory, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  const npm = await npmInvocation();
  await run(
    npm.executable,
    [
      ...npm.prefix,
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: stagingDirectory, timeout: 120_000 },
  );
  await fs.rename(stagingDirectory, runtimeDirectory);
  return runtimeDirectory;
}

async function waitForRelay(
  config,
  {
    expectedVersion = APP_VERSION,
    expectedRevision = configRevision(config),
    expectedShellRevision = SHELL_REVISION,
  } = {},
) {
  const url = `http://127.0.0.1:${config.port}/api/health`;
  for (
    let attempt = 0;
    attempt < RELAY_START_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const response = await fetch(url, {
        headers: { Host: `127.0.0.1:${config.port}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const body = await response.json();
        if (
          body?.ok === true &&
          (!expectedVersion || body.version === expectedVersion) &&
          (!expectedShellRevision ||
            body.shellRevision === expectedShellRevision) &&
          (!expectedRevision || body.configRevision === expectedRevision)
        ) {
          return body;
        }
      }
    } catch {
      // launchd may still be starting the process.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    expectedVersion
      ? `The loopback relay did not start Conductor Pocket ${expectedVersion}`
      : 'The loopback relay did not become healthy after launch',
  );
}

async function install() {
  process.umask(0o077);
  const config = await loadConfig(configPath);
  const configStat = await fs.stat(configPath);
  if ((configStat.mode & 0o077) !== 0) {
    throw new Error('Refusing to install: relay config is readable outside this user');
  }
  if (
    config.developmentMode ||
    !config.requireTailscaleIdentity ||
    !config.publicOrigin.startsWith('https://')
  ) {
    throw new Error(
      'Refusing to install: production HTTPS and Tailscale identity are required',
    );
  }
  const dataDirectory = path.dirname(configPath);
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDirectory, 0o700);
  const runtimeParent = path.join(dataDirectory, 'runtimes');
  const runtimeDirectory = await installStableRuntime(dataDirectory);
  const stdoutPath = path.join(dataDirectory, 'relay.out.log');
  const stderrPath = path.join(dataDirectory, 'relay.err.log');
  const cliPath = path.join(runtimeDirectory, 'src', 'cli.mjs');
  const interpreterPath = await resolveInterpreterPath();
  const plist = relayLaunchAgentPlist({
    interpreterPath,
    cliPath,
    runtimeDirectory,
    relayConfigPath: configPath,
    stdoutPath,
    stderrPath,
  });
  let previousLoadedRuntimeDirectory = null;
  let previousLoadedPlist = null;
  let previousLoadedRuntimeKnown = true;
  let previousJobWasLoadedAtSnapshot = false;
  try {
    const { stdout } = await run('/bin/launchctl', [
      'print',
      `gui/${process.getuid()}/${label}`,
    ]);
    const workingDirectory = /^\s*working directory = (.+)$/m.exec(
      stdout,
    )?.[1]?.trim();
    const loadedArguments = launchdArguments(stdout);
    previousLoadedRuntimeDirectory = await runtimeForLoadedLaunchdJob(
      runtimeParent,
      loadedArguments,
      { configPath, workingDirectory },
    );
    previousLoadedPlist = relayLaunchAgentPlist({
      interpreterPath: loadedArguments[0],
      cliPath: loadedArguments[2],
      runtimeDirectory: previousLoadedRuntimeDirectory,
      relayConfigPath: loadedArguments[5],
      stdoutPath,
      stderrPath,
    });
    previousJobWasLoadedAtSnapshot = true;
  } catch (error) {
    if (!launchdNotFound(error)) {
      previousLoadedRuntimeKnown = false;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[install-relay] loaded rollback runtime is unknown: ${message}`,
      );
    }
  }
  let previousPlist = null;
  try {
    previousPlist = await fs.readFile(launchAgentPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let previousJobWasLoaded = false;
  let plistReplaced = false;
  if (!previousLoadedRuntimeKnown) {
    throw new Error('Refusing to replace an unverified loaded relay');
  }
  try {
    await writePrivateFile(launchAgentPath, plist);
    plistReplaced = true;
    previousJobWasLoaded = await bootoutIfLoaded(label);
    if (
      previousLoadedRuntimeKnown &&
      previousJobWasLoaded !== previousJobWasLoadedAtSnapshot
    ) {
      previousLoadedRuntimeKnown = false;
      console.warn(
        '[install-relay] loaded relay changed during cutover; runtime retention will be skipped',
      );
    }
    await waitForLaunchdRemoval(label, RELAY_LAUNCHD_REMOVAL_TIMEOUT_MS);
    await run('/bin/launchctl', [
      'bootstrap',
      `gui/${process.getuid()}`,
      launchAgentPath,
    ]);
    await waitForRelay(config);
  } catch (primaryError) {
    if (!plistReplaced) throw primaryError;
    try {
      await bootoutIfLoaded(label);
      await waitForLaunchdRemoval(label, RELAY_LAUNCHD_REMOVAL_TIMEOUT_MS);
      const rollbackPlist = rollbackPlistForLoadedRelay({
        previousJobWasLoaded,
        previousLoadedPlist,
        previousPlist,
      });
      if (rollbackPlist == null) {
        await fs.unlink(launchAgentPath).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
        if (previousJobWasLoaded) {
          throw new Error('The prior relay job had no restorable LaunchAgent');
        }
      } else {
        await writePrivateFile(launchAgentPath, rollbackPlist);
        if (previousJobWasLoaded) {
          await run('/bin/launchctl', [
            'bootstrap',
            `gui/${process.getuid()}`,
            launchAgentPath,
          ]);
          await waitForRelay(config, {
            expectedVersion: null,
            expectedRevision: null,
            expectedShellRevision: null,
          });
        }
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [primaryError, rollbackError],
        'The relay install failed and the previous LaunchAgent could not be restored',
      );
    }
    throw primaryError;
  }

  try {
    if (!previousLoadedRuntimeKnown) {
      throw new Error('prior rollback runtime could not be verified');
    }
    const retention = await pruneStableRuntimes(
      runtimeParent,
      runtimeDirectory,
      { rollbackRuntime: previousLoadedRuntimeDirectory },
    );
    if (retention.removed.length > 0) {
      process.stdout.write(
        `[install-relay] removed ${retention.removed.length} retired runtime directories\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[install-relay] runtime retention skipped: ${message}`);
  }

  process.stdout.write(`Conductor Pocket relay installed.

Private URL: ${config.publicOrigin}
LaunchAgent: ${launchAgentPath}
Stable runtime: ${runtimeDirectory}
Network ingress: managed by the dedicated Conductor Pocket Tailscale node

One Mac permission remains:
System Settings → Privacy & Security → Accessibility
Allow the Node executable used by this relay:
${process.execPath}

Then run: npm run doctor
`);
}

withOperationLock('install the stable Pocket relay', install).catch((error) => {
  const details =
    error instanceof AggregateError
      ? [error.message, ...error.errors.map((cause) => cause?.message)]
          .filter(Boolean)
          .join('\n')
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`${details}\n`);
  process.exitCode = 1;
});
