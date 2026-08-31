#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const home = process.env.POCKET_WATCHDOG_HOME || os.homedir();
const label = 'com.ovo.pocket-watchdog';
const target = `gui/${process.getuid()}/${label}`;
const launchAgentPath = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
const runtimeParent = path.join(home, '.local', 'lib', 'pocket-watchdog');
const binDirectory = path.join(home, '.local', 'bin');
const doctorPath = path.join(binDirectory, 'pocket-doctor');
const logDirectory = path.join(home, '.config', 'pocket-watchdog');
const preparedLaunchAgentPath = path.join(logDirectory, `${label}.plist`);

process.umask(0o077);

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function stableNode() {
  const actual = await fs.realpath(process.execPath);
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    try {
      if ((await fs.realpath(candidate)) === actual) return candidate;
    } catch {
      // Try the next stable interpreter path.
    }
  }
  return process.execPath;
}

async function privateAtomicWrite(filePath, content, mode = 0o600) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, content, { flag: 'wx', mode });
  try {
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, mode);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const prepareOnly = process.argv.includes('--prepare-only');
  const previousPlist = await fs.readFile(launchAgentPath, 'utf8').catch(
    (error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    },
  );
  const wasLoaded = prepareOnly
    ? false
    : await run('/bin/launchctl', ['print', target], {
        timeout: 5_000,
      }).then(
        () => true,
        () => false,
      );
  await fs.mkdir(runtimeParent, { recursive: true, mode: 0o700 });
  await fs.mkdir(binDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(launchAgentPath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(runtimeParent, 0o700);
  await fs.chmod(logDirectory, 0o700);
  try {
    const existingDoctor = await fs.readFile(doctorPath, 'utf8');
    if (!existingDoctor.startsWith('#!/bin/sh\n# pocket-watchdog doctor\n')) {
      throw new Error(`${doctorPath} exists and is not managed by Pocket watchdog`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const suffix = `runtime-${Date.now()}-${process.pid}`;
  const staging = path.join(runtimeParent, `.installing-${suffix}`);
  const runtime = path.join(runtimeParent, suffix);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    await fs.cp(path.join(packageRoot, 'src'), path.join(staging, 'src'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await fs.copyFile(path.join(packageRoot, 'package.json'), path.join(staging, 'package.json'));
    await fs.chmod(path.join(staging, 'src', 'cli.mjs'), 0o700);
    await fs.rename(staging, runtime);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const node = await stableNode();
  const cliPath = path.join(runtime, 'src', 'cli.mjs');
  // Explicit, absolute, and ordered so the job resolves the same binaries a
  // login shell would: Homebrew node for safe-imessage's shebang, then the
  // user's own bin, then the system defaults.
  const launchdPath = [
    path.dirname(node),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>--no-warnings=ExperimentalWarning</string>
    <string>${xml(cliPath)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- launchd hands a job a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin). That is
       not enough here: safe-imessage is a '#!/usr/bin/env node' script, so without
       Homebrew on PATH every alert dies with "env: node: No such file or
       directory" and the watchdog goes silent exactly when it matters. The
       Tailscale lookups degrade the same way and report a false Funnel CRITICAL.
       Observed live 2026-08-29 before this key existed. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(launchdPath)}</string>
  </dict>
  <key>StartInterval</key><integer>600</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(logDirectory, 'watchdog.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDirectory, 'watchdog.err.log'))}</string>
</dict>
</plist>
`;
  const plistDestination = prepareOnly
    ? preparedLaunchAgentPath
    : launchAgentPath;
  await privateAtomicWrite(plistDestination, plist);

  await privateAtomicWrite(
    doctorPath,
    '#!/bin/sh\n# pocket-watchdog doctor\n' +
      `exec ${shellQuote(node)} --no-warnings=ExperimentalWarning ${shellQuote(cliPath)} doctor "$@"\n`,
    0o700,
  );
  if (prepareOnly) {
    console.log(`Prepared ${label} at ${preparedLaunchAgentPath}; it is not loaded.`);
    console.log(`Doctor: ${doctorPath}`);
    return;
  }

  await run('/bin/launchctl', ['bootout', target], { timeout: 5_000 }).catch(() => {});
  try {
    await run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, launchAgentPath], { timeout: 10_000 });
    await run('/bin/launchctl', ['print', target], { timeout: 5_000 });
  } catch (error) {
    await run('/bin/launchctl', ['bootout', target], { timeout: 5_000 }).catch(() => {});
    if (previousPlist !== null) {
      await privateAtomicWrite(launchAgentPath, previousPlist);
      if (wasLoaded) {
        await run('/bin/launchctl', [
          'bootstrap',
          `gui/${process.getuid()}`,
          launchAgentPath,
        ], { timeout: 10_000 });
      }
    } else {
      await fs.rm(launchAgentPath, { force: true });
    }
    throw error;
  }
  console.log(`Loaded ${label} with a 600 second interval.`);
  console.log(`Doctor: ${doctorPath}`);
}

main().catch((error) => {
  console.error(`Watchdog install failed: ${error.message}`);
  process.exitCode = 1;
});
