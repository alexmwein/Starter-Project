#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccessibilityTransport } from './accessibility.mjs';
import {
  ConfigStore,
  createConfig,
  getVerificationCode,
  loadConfig,
  rotatePairing,
  saveConfig,
} from './config.mjs';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_CONFIG_PATH,
  DEFAULT_PORT,
} from './constants.mjs';
import { ConductorDatabase, DatabaseWatcher } from './conductor-db.mjs';
import { SecurityManager } from './security.mjs';
import { createPocketServer } from './server.mjs';

const execFileAsync = promisify(execFile);
process.umask(0o077);

function parseArguments(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      parsed._.push(value);
      continue;
    }
    const [key, inlineValue] = value.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (values[index + 1] && !values[index + 1].startsWith('--')) {
      parsed[key] = values[index + 1];
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function integerOption(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected an integer, got ${value}`);
  return parsed;
}

async function existingExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known location.
    }
  }
  return null;
}

async function tailscaleExecutable() {
  return existingExecutable([
    path.join(os.homedir(), '.local', 'bin', 'tailscale'),
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ]);
}

async function tailscaleStatus() {
  const executable = await tailscaleExecutable();
  if (!executable) return { ok: false, reason: 'tailscale_not_installed' };
  try {
    const { stdout } = await execFileAsync(executable, ['status', '--json'], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const status = JSON.parse(stdout);
    const dnsName = status.Self?.DNSName?.replace(/\.$/, '') || null;
    if (status.BackendState !== 'Running' || !dnsName) {
      return { ok: false, reason: 'tailscale_not_running', executable, status };
    }
    return {
      ok: true,
      executable,
      dnsName,
      publicOrigin: `https://${dnsName}`,
      self: status.Self,
    };
  } catch {
    return { ok: false, reason: 'tailscale_status_failed', executable };
  }
}

async function macName() {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/scutil', [
      '--get',
      'ComputerName',
    ]);
    if (stdout.trim()) return stdout.trim();
  } catch {
    // The hostname is a safe fallback.
  }
  return os.hostname();
}

function pairingOutput(config, pairingCode) {
  const url = `${config.publicOrigin}/#pair=${encodeURIComponent(pairingCode)}`;
  return [
    '',
    'Pairing link (single use, expires in 15 minutes):',
    url,
    '',
    `Verification code shown on both devices: ${getVerificationCode(config)}`,
    '',
    'Do not post this link or put it in a shared password manager.',
  ].join('\n');
}

async function setup(options) {
  const configPath = path.resolve(options.config || DEFAULT_CONFIG_PATH);
  const port = integerOption(options.port, DEFAULT_PORT);
  const developmentMode = options.development === true;
  let publicOrigin = options.origin;
  if (!publicOrigin && developmentMode) {
    publicOrigin = `http://127.0.0.1:${port}`;
  }
  if (!publicOrigin) {
    const tailscale = await tailscaleStatus();
    if (!tailscale.ok) {
      throw new Error(
        'Tailscale must be connected before setup. Open Tailscale on the Mac and rerun npm run setup.',
      );
    }
    publicOrigin = tailscale.publicOrigin;
  }

  try {
    await fs.access(configPath);
    throw new Error(
      `Config already exists at ${configPath}. Use the pair command to create another one-time link.`,
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const created = createConfig({
    publicOrigin,
    port,
    developmentMode,
    requireTailscaleIdentity: !developmentMode,
  });
  created.config.macName = await macName();
  await saveConfig(configPath, created.config);
  process.stdout.write(
    `${APP_NAME} config created at ${configPath}\n${pairingOutput(
      created.config,
      created.pairingCode,
    )}\n`,
  );
}

async function pair(options) {
  const configPath = path.resolve(options.config || DEFAULT_CONFIG_PATH);
  const config = await loadConfig(configPath);
  const rotated = rotatePairing(config);
  await saveConfig(configPath, rotated.config);
  process.stdout.write(`${pairingOutput(rotated.config, rotated.pairingCode)}\n`);
}

async function serve(options) {
  const configPath = path.resolve(options.config || DEFAULT_CONFIG_PATH);
  const config = await loadConfig(configPath);
  const store = new ConfigStore(configPath, config);
  const database = new ConductorDatabase(config.dbPath);
  const watcher = new DatabaseWatcher(config.dbPath);
  const transport = new AccessibilityTransport();
  const security = new SecurityManager(store);
  const server = createPocketServer({
    configStore: store,
    security,
    database,
    watcher,
    transport,
  });
  watcher.start();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bindHost, resolve);
  });
  process.stdout.write(
    `${APP_NAME} ${APP_VERSION} listening on http://${config.bindHost}:${config.port}\nPrivate URL: ${config.publicOrigin}\n`,
  );

  const shutdown = () => {
    server.close(() => {
      database.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function doctor(options) {
  const configPath = path.resolve(options.config || DEFAULT_CONFIG_PATH);
  let config;
  try {
    config = await loadConfig(configPath);
  } catch {
    config = null;
  }
  const tailscale = await tailscaleStatus();
  const transport = new AccessibilityTransport();
  const accessibility = await transport.doctor();
  let database = { ok: false, reason: 'config_missing' };
  if (config) {
    try {
      const conductor = new ConductorDatabase(config.dbPath);
      const counts = conductor.listWorkspaces().length;
      conductor.close();
      database = { ok: true, workspaceCount: counts };
    } catch {
      database = { ok: false, reason: 'database_unavailable' };
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        config: config
          ? {
              ok: true,
              path: configPath,
              publicOrigin: config.publicOrigin,
              loopbackOnly: config.bindHost === '127.0.0.1',
              tailscaleIdentityRequired: config.requireTailscaleIdentity,
              pairedDevices: config.devices.length,
            }
          : { ok: false, path: configPath },
        tailscale: {
          ok: tailscale.ok,
          reason: tailscale.ok ? null : tailscale.reason,
          dnsName: tailscale.ok ? tailscale.dnsName : null,
        },
        conductorDatabase: database,
        accessibility,
      },
      null,
      2,
    )}\n`,
  );
}

function usage() {
  process.stdout.write(`Usage:
  node src/cli.mjs setup [--origin https://mac.tailnet.ts.net] [--port 4317]
  node src/cli.mjs pair
  node src/cli.mjs serve
  node src/cli.mjs doctor

All commands accept --config /absolute/path/config.json.
`);
}

const options = parseArguments(process.argv.slice(2));
const command = options._[0];

try {
  if (command === 'setup') await setup(options);
  else if (command === 'pair') await pair(options);
  else if (command === 'serve') await serve(options);
  else if (command === 'doctor') await doctor(options);
  else usage();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
