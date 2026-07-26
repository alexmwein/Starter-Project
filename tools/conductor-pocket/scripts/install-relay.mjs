import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { APP_VERSION } from '../src/constants.mjs';
import {
  assertEmptyTailscaleConfig,
  assertPrivateServeStatus,
} from '../src/tailscale-config.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
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

async function tailscaleExecutable() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'tailscale'),
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Tailscale CLI was not found');
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

async function waitForRelay(config) {
  const url = `http://127.0.0.1:${config.port}/api/health`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Host: `127.0.0.1:${config.port}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // launchd may still be starting the process.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('The loopback relay did not become healthy after launch');
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
  const tailscale = await tailscaleExecutable();
  const { stdout: statusOutput } = await run(tailscale, ['status', '--json']);
  const status = JSON.parse(statusOutput);
  const dnsName = status.Self?.DNSName?.replace(/\.$/, '') || null;
  if (status.BackendState !== 'Running' || !dnsName) {
    throw new Error('Tailscale is not connected on this Mac');
  }
  if (
    config.publicOrigin !== `https://${dnsName}` ||
    config.rpId !== dnsName
  ) {
    throw new Error(
      'Refusing to install: config origin does not match this Mac Tailscale identity',
    );
  }
  const { stdout: funnelOutput } = await run(tailscale, ['funnel', 'status', '--json']);
  const funnel = JSON.parse(funnelOutput || '{}');
  assertEmptyTailscaleConfig(funnel, 'Funnel');
  const { stdout: serveOutput } = await run(tailscale, ['serve', 'status', '--json']);
  const serve = JSON.parse(serveOutput || '{}');
  assertEmptyTailscaleConfig(serve, 'Serve');

  const dataDirectory = path.dirname(configPath);
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDirectory, 0o700);
  const runtimeDirectory = await installStableRuntime(dataDirectory);
  const stdoutPath = path.join(dataDirectory, 'relay.out.log');
  const stderrPath = path.join(dataDirectory, 'relay.err.log');
  const cliPath = path.join(runtimeDirectory, 'src', 'cli.mjs');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>--no-warnings=ExperimentalWarning</string>
    <string>${xml(cliPath)}</string>
    <string>serve</string>
    <string>--config</string>
    <string>${xml(configPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(runtimeDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrPath)}</string>
</dict>
</plist>
`;
  await fs.mkdir(path.dirname(launchAgentPath), { recursive: true });
  const launchAgentTemporaryPath = `${launchAgentPath}.tmp-${process.pid}`;
  await fs.writeFile(launchAgentTemporaryPath, plist, {
    mode: 0o600,
    flag: 'wx',
  });
  await fs.rename(launchAgentTemporaryPath, launchAgentPath);
  await fs.chmod(launchAgentPath, 0o600);

  const serviceTarget = `gui/${process.getuid()}/${label}`;
  try {
    await run('/bin/launchctl', ['bootout', serviceTarget]);
  } catch {
    // The service was not installed yet.
  }
  await run('/bin/launchctl', [
    'bootstrap',
    `gui/${process.getuid()}`,
    launchAgentPath,
  ]);
  await waitForRelay(config);

  let configuredServe = false;
  try {
    await run(tailscale, [
      'serve',
      '--bg',
      '--yes',
      `http://127.0.0.1:${config.port}`,
    ]);
    configuredServe = true;
    const { stdout: finalServeOutput } = await run(tailscale, [
      'serve',
      'status',
      '--json',
    ]);
    assertPrivateServeStatus(JSON.parse(finalServeOutput || '{}'), {
      rpId: config.rpId,
      port: config.port,
    });
    const { stdout: finalFunnelOutput } = await run(tailscale, [
      'funnel',
      'status',
      '--json',
    ]);
    assertEmptyTailscaleConfig(
      JSON.parse(finalFunnelOutput || '{}'),
      'Funnel',
    );
  } catch (error) {
    if (configuredServe) {
      await run(tailscale, ['serve', 'off']).catch(() => {});
    }
    throw error;
  }

  process.stdout.write(`Conductor Pocket relay installed.

Private URL: ${config.publicOrigin}
LaunchAgent: ${launchAgentPath}
Stable runtime: ${runtimeDirectory}

One Mac permission remains:
System Settings → Privacy & Security → Accessibility
Allow the Node executable used by this relay:
${process.execPath}

Then run: npm run doctor
`);
}

install().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
