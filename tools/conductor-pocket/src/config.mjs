import fs from 'node:fs/promises';
import path from 'node:path';
import { randomToken, sha256 } from './encoding.mjs';
import {
  APP_NAME,
  DEFAULT_CONFIG_PATH,
  DEFAULT_DB_PATH,
  DEFAULT_PORT,
  DEVICE_SESSION_TTL_SECONDS,
  LOOPBACK_HOST,
  PAIRING_TTL_MS,
  REAUTHENTICATION_MODE_FACE_ID,
  REAUTHENTICATION_MODE_TAILSCALE_SESSION,
} from './constants.mjs';
import { withOperationLock } from './operation-lock.mjs';

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

function validateOriginRetirement(raw, publicOrigin) {
  if (raw == null) return null;
  assertObject(raw, 'originRetirement');
  const sourceOrigin = parsePublicOrigin(raw.sourceOrigin);
  if (sourceOrigin !== publicOrigin) {
    throw new Error('originRetirement must belong to the current publicOrigin');
  }
  if (!Array.isArray(raw.requiredDeviceIds) || !Array.isArray(raw.retiredDeviceIds)) {
    throw new Error('originRetirement device lists are invalid');
  }
  const requiredDeviceIds = [...new Set(raw.requiredDeviceIds)];
  const retiredDeviceIds = [...new Set(raw.retiredDeviceIds)];
  if (
    requiredDeviceIds.some((id) => typeof id !== 'string' || !id) ||
    retiredDeviceIds.some(
      (id) => typeof id !== 'string' || !requiredDeviceIds.includes(id),
    )
  ) {
    throw new Error('originRetirement contains an invalid device id');
  }
  if (
    typeof raw.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.startedAt))
  ) {
    throw new Error('originRetirement.startedAt is invalid');
  }
  return {
    sourceOrigin,
    requiredDeviceIds,
    retiredDeviceIds,
    startedAt: new Date(raw.startedAt).toISOString(),
  };
}

function optionalTimestamp(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return new Date(value).toISOString();
}

function validateDevices(rawDevices) {
  if (!Array.isArray(rawDevices)) throw new Error('devices must be an array');
  return rawDevices.map((rawDevice, index) => {
    assertObject(rawDevice, `devices[${index}]`);
    const lockGeneration = rawDevice.lockGeneration ?? 0;
    if (
      !Number.isSafeInteger(lockGeneration) ||
      lockGeneration < 0
    ) {
      throw new Error(
        `devices[${index}].lockGeneration is invalid`,
      );
    }
    return {
      ...rawDevice,
      lockGeneration,
      previousSessionHash:
        typeof rawDevice.previousSessionHash === 'string' &&
        rawDevice.previousSessionHash
          ? rawDevice.previousSessionHash
          : null,
      previousSessionExpiresAt: optionalTimestamp(
        rawDevice.previousSessionExpiresAt,
        `devices[${index}].previousSessionExpiresAt`,
      ),
      sessionExpiresAt: optionalTimestamp(
        rawDevice.sessionExpiresAt,
        `devices[${index}].sessionExpiresAt`,
      ),
      trustedUntil: optionalTimestamp(
        rawDevice.trustedUntil,
        `devices[${index}].trustedUntil`,
      ),
      lockedAt: optionalTimestamp(
        rawDevice.lockedAt,
        `devices[${index}].lockedAt`,
      ),
    };
  });
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
  if (typeof raw.requireTailscaleIdentity !== 'boolean') {
    throw new Error('requireTailscaleIdentity must be boolean');
  }
  const reauthenticationMode =
    raw.reauthenticationMode || REAUTHENTICATION_MODE_FACE_ID;
  const allowedTailscaleLogin = raw.allowedTailscaleLogin || null;
  if (
    reauthenticationMode !== REAUTHENTICATION_MODE_FACE_ID &&
    reauthenticationMode !== REAUTHENTICATION_MODE_TAILSCALE_SESSION
  ) {
    throw new Error('reauthenticationMode is invalid');
  }
  if (
    reauthenticationMode === REAUTHENTICATION_MODE_TAILSCALE_SESSION &&
    !raw.requireTailscaleIdentity
  ) {
    throw new Error(
      'tailscale-session requires mandatory Tailscale identity',
    );
  }
  const devices = validateDevices(raw.devices);
  if (
    devices.some(
      (device) =>
        Boolean(device.previousSessionHash) !==
        Boolean(device.previousSessionExpiresAt),
    )
  ) {
    throw new Error(
      'previous device session hash and expiry must be stored together',
    );
  }
  if (
    reauthenticationMode === REAUTHENTICATION_MODE_TAILSCALE_SESSION &&
    (!allowedTailscaleLogin ||
      devices.some(
        (device) =>
          !device.sessionExpiresAt ||
          typeof device.tailscaleLogin !== 'string' ||
          device.tailscaleLogin.toLowerCase() !==
            allowedTailscaleLogin.toLowerCase(),
      ))
  ) {
    throw new Error(
      'tailscale-session requires a pinned identity and server-side device expiry',
    );
  }
  const originRetirement = validateOriginRetirement(
    raw.originRetirement,
    publicOrigin,
  );
  return {
    ...raw,
    publicOrigin,
    devices,
    reauthenticationMode,
    allowedTailscaleLogin,
    pairing: raw.pairing || null,
    originRetirement,
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
    reauthenticationMode: REAUTHENTICATION_MODE_FACE_ID,
    allowedTailscaleLogin: null,
    csrfSecret: randomToken(32),
    originRetirement: null,
    pairing: {
      codeHash: sha256(pairingCode),
      expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
    },
    devices: [],
  });
  return { config, pairingCode };
}

export function setReauthenticationMode(
  config,
  mode,
  now = Date.now(),
) {
  const validated = validateConfig(config);
  if (validated.reauthenticationMode === mode) {
    return validated;
  }
  if (mode === REAUTHENTICATION_MODE_FACE_ID) {
    return validateConfig({
      ...validated,
      reauthenticationMode: REAUTHENTICATION_MODE_FACE_ID,
    });
  }
  if (mode !== REAUTHENTICATION_MODE_TAILSCALE_SESSION) {
    throw new Error('reauthenticationMode is invalid');
  }
  if (
    !validated.requireTailscaleIdentity ||
    !validated.allowedTailscaleLogin ||
    validated.devices.length === 0
  ) {
    throw new Error(
      'tailscale-session requires a paired, pinned Tailscale identity',
    );
  }
  const lockedAt = new Date(now).toISOString();
  const sessionExpiresAt = new Date(
    now + DEVICE_SESSION_TTL_SECONDS * 1000,
  ).toISOString();
  return validateConfig({
    ...validated,
    reauthenticationMode: REAUTHENTICATION_MODE_TAILSCALE_SESSION,
    devices: validated.devices.map((device) => ({
      ...device,
      sessionExpiresAt,
      trustedUntil: null,
      lockedAt,
      lockGeneration: device.lockGeneration + 1,
      previousSessionHash: null,
      previousSessionExpiresAt: null,
    })),
  });
}

export function rotatePairing(config, now = Date.now()) {
  const validated = validateConfig(config);
  if (validated.originRetirement) {
    throw new Error(
      'Pairing stays disabled until the old-origin retirement is complete',
    );
  }
  const pairingCode = randomToken(24);
  return {
    pairingCode,
    config: validateConfig({
      ...validated,
      pairing: {
        codeHash: sha256(pairingCode),
        expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
      },
    }),
  };
}

export function beginOriginRetirement(config, now = Date.now()) {
  const validated = validateConfig(config);
  if (validated.originRetirement) return validated;
  return validateConfig({
    ...validated,
    pairing: null,
    originRetirement: {
      sourceOrigin: validated.publicOrigin,
      requiredDeviceIds: validated.devices.map((device) => device.id),
      retiredDeviceIds: [],
      startedAt: new Date(now).toISOString(),
    },
  });
}

export function originRetirementComplete(config) {
  const validated = validateConfig(config);
  const retirement = validated.originRetirement;
  if (!retirement) return false;
  const retired = new Set(retirement.retiredDeviceIds);
  return (
    validated.devices.length === 0 &&
    retirement.requiredDeviceIds.every((id) => retired.has(id))
  );
}

export function migrateToDedicatedOrigin(config, publicOrigin, now = Date.now()) {
  if (!originRetirementComplete(config)) {
    throw new Error(
      'Every old-origin device must complete the local retirement purge before migration',
    );
  }
  const origin = parsePublicOrigin(publicOrigin);
  const pairingCode = randomToken(24);
  return {
    pairingCode,
    config: validateConfig({
      ...config,
      publicOrigin: origin,
      rpId: new URL(origin).hostname,
      developmentMode: false,
      requireTailscaleIdentity: true,
      reauthenticationMode: REAUTHENTICATION_MODE_FACE_ID,
      allowedTailscaleLogin: null,
      csrfSecret: randomToken(32),
      originRetirement: null,
      pairing: {
        codeHash: sha256(pairingCode),
        expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
      },
      devices: [],
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

export function configRevision(config) {
  const validated = validateConfig(config);
  const devices = validated.devices
    .map((device) => ({
      id: device.id,
      sessionHash: device.sessionHash,
      previousSessionHash: device.previousSessionHash,
      previousSessionExpiresAt: device.previousSessionExpiresAt,
      tailscaleLogin: device.tailscaleLogin,
      passkeyId: device.passkey?.id,
      passkeyCounter: device.passkey?.counter,
      sessionExpiresAt: device.sessionExpiresAt,
      trustedUntil: device.trustedUntil,
      lockedAt: device.lockedAt,
      lockGeneration: device.lockGeneration,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const retirement = validated.originRetirement
    ? {
        sourceOrigin: validated.originRetirement.sourceOrigin,
        requiredDeviceIds: [
          ...validated.originRetirement.requiredDeviceIds,
        ].sort(),
        retiredDeviceIds: [
          ...validated.originRetirement.retiredDeviceIds,
        ].sort(),
        startedAt: validated.originRetirement.startedAt,
      }
    : null;
  return sha256(
    JSON.stringify({
      version: validated.version,
      bindHost: validated.bindHost,
      port: validated.port,
      publicOrigin: validated.publicOrigin,
      rpId: validated.rpId,
      developmentMode: validated.developmentMode,
      requireTailscaleIdentity: validated.requireTailscaleIdentity,
      reauthenticationMode: validated.reauthenticationMode,
      allowedTailscaleLogin: validated.allowedTailscaleLogin,
      csrfSecret: validated.csrfSecret,
      pairing: validated.pairing,
      devices,
      retirement,
    }),
  );
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
      const lockPath = path.join(
        path.dirname(this.#configPath),
        'operation.lock',
      );
      return withOperationLock(
        'relay configuration update',
        async () => {
          const latest = await loadConfig(this.#configPath);
          const draft = structuredClone(latest);
          const next = (await mutator(draft)) || draft;
          const validated = validateConfig(next);
          await saveConfig(this.#configPath, validated);
          this.#config = validated;
          return this.#config;
        },
        lockPath,
      );
    };
    this.#writeQueue = this.#writeQueue.then(run, run);
    return this.#writeQueue;
  }
}
