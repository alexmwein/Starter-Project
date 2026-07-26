import fs from 'node:fs/promises';
import path from 'node:path';
import { randomToken, sha256 } from './encoding.mjs';
import {
  APP_NAME,
  DEFAULT_CONFIG_PATH,
  DEFAULT_DB_PATH,
  DEFAULT_PORT,
  LOOPBACK_HOST,
  PAIRING_TTL_MS,
} from './constants.mjs';

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function parsePublicOrigin(value, allowInsecureLocalhost = false) {
  const url = new URL(value);
  const isLocal =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && isLocal && url.protocol === 'http:')) {
    throw new Error('publicOrigin must use HTTPS');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('publicOrigin must not include a path, query, or fragment');
  }
  return url.origin;
}

export function validateConfig(raw) {
  assertObject(raw, 'config');
  if (raw.version !== 1) throw new Error('Unsupported config version');
  if (raw.bindHost !== LOOPBACK_HOST) {
    throw new Error(`bindHost must be ${LOOPBACK_HOST}; LAN/public binding is forbidden`);
  }
  if (!Number.isInteger(raw.port) || raw.port < 1024 || raw.port > 65535) {
    throw new Error('port must be an integer from 1024 through 65535');
  }
  const publicOrigin = parsePublicOrigin(raw.publicOrigin, raw.developmentMode === true);
  const originHostname = new URL(publicOrigin).hostname;
  if (raw.rpId !== originHostname) {
    throw new Error('rpId must exactly match the publicOrigin hostname');
  }
  if (typeof raw.csrfSecret !== 'string' || raw.csrfSecret.length < 32) {
    throw new Error('csrfSecret is missing or too short');
  }
  if (typeof raw.dbPath !== 'string' || !path.isAbsolute(raw.dbPath)) {
    throw new Error('dbPath must be absolute');
  }
  if (!Array.isArray(raw.devices)) throw new Error('devices must be an array');
  if (typeof raw.requireTailscaleIdentity !== 'boolean') {
    throw new Error('requireTailscaleIdentity must be boolean');
  }
  return {
    ...raw,
    publicOrigin,
    devices: raw.devices,
    allowedTailscaleLogin: raw.allowedTailscaleLogin || null,
    pairing: raw.pairing || null,
  };
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  return validateConfig(raw);
}

export async function saveConfig(configPath, config) {
  const validated = validateConfig(config);
  const directory = path.dirname(configPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporaryPath = path.join(
    directory,
    `.config.${process.pid}.${randomToken(8)}.tmp`,
  );
  await fs.writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await fs.rename(temporaryPath, configPath);
  await fs.chmod(configPath, 0o600);
}

export function createConfig({
  publicOrigin,
  dbPath = DEFAULT_DB_PATH,
  port = DEFAULT_PORT,
  developmentMode = false,
  requireTailscaleIdentity = !developmentMode,
  now = Date.now(),
} = {}) {
  const origin = parsePublicOrigin(publicOrigin, developmentMode);
  const pairingCode = randomToken(24);
  const config = validateConfig({
    version: 1,
    appName: APP_NAME,
    bindHost: LOOPBACK_HOST,
    port,
    publicOrigin: origin,
    rpId: new URL(origin).hostname,
    dbPath,
    developmentMode,
    requireTailscaleIdentity,
    allowedTailscaleLogin: null,
    csrfSecret: randomToken(32),
    pairing: {
      codeHash: sha256(pairingCode),
      expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
    },
    devices: [],
  });
  return { config, pairingCode };
}

export function rotatePairing(config, now = Date.now()) {
  const pairingCode = randomToken(24);
  return {
    pairingCode,
    config: validateConfig({
      ...config,
      pairing: {
        codeHash: sha256(pairingCode),
        expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
      },
    }),
  };
}

export function getVerificationCode(config) {
  if (!config.pairing) return null;
  return config.pairing.codeHash
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 6)
    .toUpperCase();
}

export class ConfigStore {
  #config;
  #configPath;
  #writeQueue = Promise.resolve();

  constructor(configPath, config) {
    this.#configPath = configPath;
    this.#config = validateConfig(config);
  }

  get value() {
    return this.#config;
  }

  async update(mutator) {
    const run = async () => {
      const draft = structuredClone(this.#config);
      const next = (await mutator(draft)) || draft;
      const validated = validateConfig(next);
      await saveConfig(this.#configPath, validated);
      this.#config = validated;
      return this.#config;
    };
    this.#writeQueue = this.#writeQueue.then(run, run);
    return this.#writeQueue;
  }
}
