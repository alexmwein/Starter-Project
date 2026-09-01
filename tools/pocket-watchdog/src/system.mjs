import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const defaultExecFile = promisify(nodeExecFile);
const RELAY_LABEL = 'com.ovo.conductor-pocket';
const LOOPBACK_HEALTH_TIMEOUT_MS = 3_000;
export const TAILNET_HEALTH_TIMEOUT_MS = 15_000;
const TAILNET_RETRY_DELAY_MS = 250;
const SIDECAR_SOCKET_PARTS = [
  '.config',
  'conductor-pocket',
  'tailscale',
  'tailscaled.sock',
];
const TAILSCALE_CANDIDATES = [
  '/opt/homebrew/opt/tailscale/bin/tailscale',
  '/usr/local/opt/tailscale/bin/tailscale',
];

function enabledValue(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(enabledValue);
  if (value && typeof value === 'object') {
    return Object.values(value).some(enabledValue);
  }
  return false;
}

export function hasEnabledFunnel(value) {
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, 'AllowFunnel') && enabledValue(value.AllowFunnel)) {
    return true;
  }
  return Object.values(value).some(hasEnabledFunnel);
}

async function directoryNames(directory, predicate) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter(predicate)
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function codexRegistrySnapshot({
  vaultDirectory,
  routesDirectory,
}) {
  let readable = true;
  for (const directory of [vaultDirectory, routesDirectory]) {
    try {
      if (!(await fs.stat(directory)).isDirectory()) readable = false;
    } catch {
      readable = false;
    }
  }
  const vaultSeats = (await directoryNames(
    vaultDirectory,
    (entry) =>
      entry.isFile() &&
      !entry.name.startsWith('.') &&
      entry.name.endsWith('.json'),
  )).map((name) => name.slice(0, -'.json'.length));
  const routeNames = await directoryNames(
    routesDirectory,
    (entry) => entry.isDirectory() && !entry.name.startsWith('.'),
  );
  const routes = await Promise.all(routeNames.map(async (name) => {
    try {
      const value = await fs.stat(path.join(routesDirectory, name, 'auth.json'));
      return { name, hasAuth: value.isFile() };
    } catch {
      return { name, hasAuth: false };
    }
  }));
  return { readable, vaultSeats, routes };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function commandOk(execFile, executable, argumentsList, options = {}) {
  try {
    const result = await execFile(executable, argumentsList, {
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
      ...options,
    });
    return { ok: true, stdout: result.stdout || '' };
  } catch {
    return { ok: false, stdout: '' };
  }
}

async function readRelayProfile(home, execFile) {
  const plistPath = path.join(
    home,
    'Library',
    'LaunchAgents',
    `${RELAY_LABEL}.plist`,
  );
  const result = await commandOk(execFile, '/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    plistPath,
  ]);
  if (!result.ok) return { profile: null, inputScriptPath: null, shellRevision: null };
  const profile = JSON.parse(result.stdout);
  const cliPath = (profile.ProgramArguments || []).find((value) =>
    typeof value === 'string' && value.endsWith('/src/cli.mjs'),
  );
  if (!cliPath) return { profile, inputScriptPath: null, shellRevision: null };
  const sourceDirectory = path.dirname(cliPath);
  let shellRevision = null;
  try {
    const constants = await fs.readFile(path.join(sourceDirectory, 'constants.mjs'), 'utf8');
    shellRevision = /export const SHELL_REVISION = ['"]([^'"]+)['"]/.exec(constants)?.[1] || null;
  } catch {
    // A missing runtime file is a revision failure, not a collector crash.
  }
  return {
    profile,
    inputScriptPath: path.join(sourceDirectory, 'conductor-input.js'),
    shellRevision,
  };
}

async function health(
  origin,
  fetchImpl,
  {
    timeoutMs = LOOPBACK_HEALTH_TIMEOUT_MS,
    retries = 0,
    retryDelayMs = TAILNET_RETRY_DELAY_MS,
    signalFactory = AbortSignal.timeout,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  let result = { ok: false, status: null, shellRevision: null };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(`${origin}/api/health`, {
        cache: 'no-store',
        signal: signalFactory(timeoutMs),
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        // An invalid health response is unhealthy.
      }
      result = {
        ok: response.ok && body?.ok === true,
        status: response.status,
        shellRevision: body?.shellRevision || null,
      };
    } catch {
      result = { ok: false, status: null, shellRevision: null };
    }
    if (result.ok || attempt === retries) return result;
    await sleep(retryDelayMs);
  }
  return result;
}

async function funnelState(home, execFile) {
  let executable = null;
  for (const candidate of TAILSCALE_CANDIDATES) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      executable = candidate;
      break;
    } catch {
      // Try the next stable Tailscale path.
    }
  }
  if (!executable) return null;
  const socket = path.join(home, ...SIDECAR_SOCKET_PARTS);
  const result = await commandOk(execFile, executable, [
    `--socket=${socket}`,
    'funnel',
    'status',
    '--json',
  ]);
  if (!result.ok) return null;
  try {
    return hasEnabledFunnel(JSON.parse(result.stdout || '{}'));
  } catch {
    return null;
  }
}

function activeRepositories(dbPath) {
  let database;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
    return {
      ok: true,
      names: database.prepare(`
      SELECT DISTINCT r.name
      FROM workspaces w
      JOIN repos r ON r.id = w.repository_id
      WHERE w.state != 'archived' AND r.hidden = 0
      ORDER BY r.name
      `).all().map((row) => row.name),
    };
  } catch {
    return { ok: false, names: [] };
  } finally {
    database?.close();
  }
}

async function sidebarSnapshot(config, inputScriptPath, execFile) {
  const repositories = activeRepositories(config.dbPath);
  if (!inputScriptPath) {
    return { ok: false, activeRepositories: repositories.names, projects: [] };
  }
  const pidLookup = await commandOk(execFile, '/usr/bin/osascript', [
    '-e',
    'tell application "System Events" to return unix id of first process whose name is "Conductor"',
  ]);
  const pid = pidLookup.stdout.trim();
  if (!pidLookup.ok || !/^\d+$/u.test(pid)) {
    return { ok: false, activeRepositories: repositories.names, projects: [] };
  }
  const result = await commandOk(
    execFile,
    '/usr/bin/osascript',
    ['-l', 'JavaScript', inputScriptPath, pid],
    {
      env: { ...process.env, POCKET_OPERATION: 'sidebar-snapshot' },
      timeout: 10_000,
    },
  );
  if (!result.ok) {
    return { ok: false, activeRepositories: repositories.names, projects: [] };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return {
      ok: repositories.ok && parsed.ok === true,
      activeRepositories: repositories.names,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    };
  } catch {
    return { ok: false, activeRepositories: repositories.names, projects: [] };
  }
}

export async function collectSnapshot({
  home = os.homedir(),
  configPath = process.env.CONDUCTOR_POCKET_CONFIG || path.join(home, '.config', 'conductor-pocket', 'config.json'),
  execFile = defaultExecFile,
  fetchImpl = fetch,
  sleep,
  tailnetSignalFactory,
  loadavg = () => os.loadavg(),
} = {}) {
  const config = await readJson(configPath);
  const disk = await fs.statfs('/');
  const freeBlocks = Number(disk.bavail ?? disk.bfree);
  const blockSize = Number(disk.bsize);
  const runtime = await readRelayProfile(home, execFile);
  const loopback = await health(`http://127.0.0.1:${config.port}`, fetchImpl);
  const tailnet = await health(config.publicOrigin, fetchImpl, {
    timeoutMs: TAILNET_HEALTH_TIMEOUT_MS,
    retries: 1,
    ...(sleep ? { sleep } : {}),
    ...(tailnetSignalFactory ? { signalFactory: tailnetSignalFactory } : {}),
  });
  const launch = await commandOk(execFile, '/bin/launchctl', [
    'print',
    `gui/${process.getuid()}/${RELAY_LABEL}`,
  ]);
  const [funnelEnabled, sidebar, codex] = await Promise.all([
    funnelState(home, execFile),
    sidebarSnapshot(config, runtime.inputScriptPath, execFile),
    codexRegistrySnapshot({
      vaultDirectory: path.join(home, '.codex-accounts'),
      routesDirectory: path.join(home, '.codex-routes'),
    }),
  ]);
  return {
    diskFreeBytes: freeBlocks * blockSize,
    relay: {
      bindHost: config.bindHost,
      loopback,
      installedShellRevision: runtime.shellRevision,
      tailnetStatus: tailnet.ok || tailnet.status !== 200
        ? tailnet.status
        : null,
      launchLoaded: launch.ok,
      funnelEnabled,
    },
    devices: (config.devices || []).map((device) => ({
      id: device.id,
      name: device.name || 'Pocket device',
      trustedUntil: device.trustedUntil,
      sessionExpiresAt: device.sessionExpiresAt,
    })),
    sidebar,
    codex,
    load5: Number(loadavg()[1]),
  };
}
