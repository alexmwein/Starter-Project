import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createConfig,
  getVerificationCode,
  loadConfig,
  saveConfig,
  validateConfig,
} from '../src/config.mjs';

test('configuration is loopback-only and stores only a pairing digest', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-pocket-config-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  const { config, pairingCode } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
    now: 1_000,
  });

  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.requireTailscaleIdentity, false);
  assert.equal(config.rpId, '127.0.0.1');
  assert.notEqual(config.pairing.codeHash, pairingCode);
  assert.equal(JSON.stringify(config).includes(pairingCode), false);
  assert.match(getVerificationCode(config), /^[A-Z0-9]{6}$/);

  await saveConfig(configPath, config);
  const saved = await loadConfig(configPath);
  assert.equal(saved.publicOrigin, 'http://127.0.0.1:4317');
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o077, 0);
});
test('configuration rejects a LAN or wildcard bind', () => {
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  assert.throws(
    () => validateConfig({ ...config, bindHost: '0.0.0.0' }),
    /loopback|127\.0\.0\.1/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        developmentMode: false,
        publicOrigin: 'http://pocket.example.com',
        rpId: 'pocket.example.com',
      }),
    /HTTPS/,
  );
});
