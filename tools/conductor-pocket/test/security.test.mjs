import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigStore, createConfig, saveConfig } from '../src/config.mjs';
import {
  SESSION_COOKIE,
  UNLOCK_IDLE_TTL_MS,
  UNLOCK_TTL_MS,
} from '../src/constants.mjs';
import { sha256 } from '../src/encoding.mjs';
import {
  SecurityManager,
  createUnlockWindow,
  evaluateUnlockWindow,
} from '../src/security.mjs';

test('unlock window enforces both idle and absolute Face ID deadlines', () => {
  const startedAt = 1_000_000;
  const idleWindow = createUnlockWindow(startedAt);
  assert.equal(
    evaluateUnlockWindow(idleWindow, startedAt + UNLOCK_IDLE_TTL_MS - 1)
      .unlocked,
    true,
  );
  assert.equal(
    evaluateUnlockWindow(idleWindow, startedAt + UNLOCK_IDLE_TTL_MS).unlocked,
    false,
  );

  const activeWindow = createUnlockWindow(startedAt);
  const touched = evaluateUnlockWindow(
    activeWindow,
    startedAt + UNLOCK_IDLE_TTL_MS - 1_000,
    { touch: true },
  );
  assert.equal(touched.unlocked, true);
  assert.equal(
    touched.unlockedUntil,
    startedAt + 2 * UNLOCK_IDLE_TTL_MS - 1_000,
  );

  const nearAbsoluteDeadline = createUnlockWindow(startedAt);
  nearAbsoluteDeadline.idleUntil = nearAbsoluteDeadline.absoluteUntil;
  const capped = evaluateUnlockWindow(
    nearAbsoluteDeadline,
    startedAt + UNLOCK_TTL_MS - 1_000,
    { touch: true },
  );
  assert.equal(capped.unlockedUntil, startedAt + UNLOCK_TTL_MS);
  assert.equal(
    evaluateUnlockWindow(
      nearAbsoluteDeadline,
      startedAt + UNLOCK_TTL_MS,
    ).unlocked,
    false,
  );
});

test('device session requires its cookie and CSRF proof and starts locked', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-pocket-security-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  const { config } = createConfig({
    publicOrigin: 'http://127.0.0.1:4317',
    developmentMode: true,
  });
  const rawSession = 'test-session-token-with-enough-entropy-for-fixture';
  config.devices = [
    {
      id: 'device-1',
      name: 'Test iPhone',
      tailscaleLogin: null,
      createdAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-01-01T00:00:00Z',
      sessionHash: sha256(rawSession),
      passkey: {
        id: 'credential-1',
        publicKey: 'AA',
        counter: 0,
        transports: ['internal'],
        backedUp: true,
      },
    },
  ];
  await saveConfig(configPath, config);
  const store = new ConfigStore(configPath, config);
  const security = new SecurityManager(store);
  const request = {
    headers: { cookie: `${SESSION_COOKIE}=${rawSession}` },
    socket: { remoteAddress: '127.0.0.1' },
  };

  const bootstrap = security.bootstrap(request);
  assert.equal(bootstrap.authenticated, true);
  assert.equal(bootstrap.unlocked, false);
  assert.match(bootstrap.csrfToken, /^[A-Za-z0-9_-]+$/);
  assert.throws(
    () => security.session(request, { requireUnlocked: true }),
    (error) => error.status === 423 && error.code === 'device_locked',
  );
  assert.throws(
    () => security.session(request, { requireCsrf: true }),
    (error) => error.status === 403 && error.code === 'csrf_denied',
  );

  request.headers['x-csrf-token'] = bootstrap.csrfToken;
  assert.equal(security.session(request, { requireCsrf: true }).device.id, 'device-1');
});

test('production identity is pinned to the paired Tailscale login', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-pocket-tail-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  const { config } = createConfig({
    publicOrigin: 'https://mac.example-tailnet.ts.net',
    developmentMode: false,
  });
  config.allowedTailscaleLogin = 'alex@example.com';
  await saveConfig(configPath, config);
  const security = new SecurityManager(new ConfigStore(configPath, config));

  assert.equal(
    security.assertTailscaleIdentity({
      headers: { 'tailscale-user-login': 'Alex@Example.com' },
    }),
    'alex@example.com',
  );
  assert.throws(
    () =>
      security.assertTailscaleIdentity({
        headers: { 'tailscale-user-login': 'other@example.com' },
      }),
    (error) => error.status === 403 && error.code === 'tailscale_identity_denied',
  );
});
